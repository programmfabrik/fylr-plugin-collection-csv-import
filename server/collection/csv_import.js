const DEBUG_INPUT = false; // Set to true to debug the input and output to a file on /tmp/post-in
const CSV_IMPORTER_DEBUG = false; // Set to true to enable the importer debug mode, this will output objects to log instead of importing them

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const jsdom = require('jsdom');


// Mocks the DOM to be able to require CUI.
global.window = new jsdom.JSDOM(`<!DOCTYPE html>`, { url: "https://example.com/" }).window;
global.window.Error = () => {
};
global.alert = () => {
};
global.navigator = window.navigator;
global.document = window.document;
global.HTMLElement = window.HTMLElement;
global.HTMLCollection = window.HTMLCollection;
global.NodeList = window.NodeList;
global.Node = window.Node;
global.self = global;
// We need to indicate ez5 that we are in headless mode and the server url
global.window.headless_mode = true;

// CUI is required in the headless ez5.js
global.CUI = require('../modules/cui');
// We need xhr2 to pollyfill the XMLHttpRequest object, xmlhttprequest is not available in node and is used by CUI and ez5
global.XMLHttpRequest = XMLHttpRequest = require("xhr2");



// ez5 outputs a lot of logs, we are going to silence them
const originalConsoleLog = console.log;
const originalConsoleInfo = console.info;
console.log = () => {};
console.info = () => {};
console.timeLog = () => {};

const EventPoller = {
    listen: () => {},
    saveEvent: () => {}
};

// Run headless ez5
const ez5jsPath = path.join(__dirname, '../modules/ez5.js');
const ez5js = fs.readFileSync(ez5jsPath, 'utf8');
//const ez5js = fs.readFileSync('../modules/easydb-webfrontend/build/web/js/easydb5.js', 'utf8');
// Ez5 is designed to run in the browser, also was coded to run all classes in global scope, so we need to run it in the global scope
// for this we are going to use eval, if we require the ez5.js file it will run in the module scope and we will not have access to the classes
eval(ez5js);


let info = undefined
let data = undefined
let csv_importer_settings = undefined
if (process.argv.length >= 3) {
    info = JSON.parse(process.argv[2])
}


let input = '';
process.stdin.on('data', d => {
    try {
        input += d.toString();
    } catch(e) {
        console.error(`Could not read input into string: ${e.message}`, e.stack);
        process.exit(1);
    }
});


process.stdin.on('end', () => {

    data = JSON.parse(input);

    if(!data.info["collection_config"]["csv_import"]["enabled"])
    {
        // If the csv import is not enabled we finish the script
        finishScript();
    }

    try {
        if(DEBUG_INPUT)
        {
            // If debug input is set then we output the input to a file and we allow the upload of the file
            fs.writeFileSync('/tmp/post-in', input);
            data = JSON.parse(input);
            finishScript();
        }

        global.window.easydb_server_url = data.info.api_url + "/api/v1";

        csv_importer_settings = data.info["collection_config"]["csv_import"]["import_settings"]["settings"];
        if (!csv_importer_settings) {
            console.error("No csv_import settings found in the collection config");
            process.exit(1);
        }
    } catch(e) {
        console.error(`Could not parse input: ${e.message}`, e.stack);
        process.exit(1);
    }

    // Check that we are uploading a csv file
    if (data.info.file.extension !== "csv") {
        finishScript();
    }

    let csvUrl = data.info.file.versions.original.url;
    if(!csvUrl) {
        finishWithError("No csv file url found in the input data");
    }
    csvUrl += "?access_token=" + data.info.api_user_access_token

    // Get the csv from the server , we use the access token included in info
    axios.get(csvUrl).then((response) => {
        // Run the importer
        runImporter(response.data).done(() => {
            finishScript();
        }).fail((error) => {
            console.error("Could not run the importer", error);
            process.exit(1);
        });
    }).catch((error) => {
        console.error("Could not get the csv file", error);
        process.exit(1);
    });
});

function runImporter(csv) {
    let dfr = new CUI.Deferred();
    ez5.defaults = {
        class: {
            User: User,
            Group: Group,
            SystemGroup: SystemGroup,
            AnonymousUser: AnonymousUser,
            SystemUser: SystemUser
        }
    }
    // Pollyfill some functions that are not available in headless mode
    Localization.prototype.init = () => {};
    Localization.prototype.setLanguage = () => { return CUI.resolvedPromise()};
    ez5.splash.show = () => {};
    ez5.splash.hide = () => {};
    ez5.rootMenu = {
        registerApp: () => {}
    }

    //Start the ez5 app
    ez5.session = new Session();
    ez5.settings = {
        version: "6.10"
    };
    ez5.tokenParam = "access_token";
    ez5.session_ready().done( () => {
        ez5.session.get(data.info.api_user_access_token).fail( (e) => {
            console.error("Could not get user session", e);
            dfr.reject();
        }).done((response, xhr) => {
            // noinspection JSVoidFunctionReturnValueUsed
            CUI.when([
                ez5.schema.load_schema(),
                (ez5.tagForm = new TagFormSimple()).load(),
                (ez5.pools = new PoolManagerList()).loadList(),
                (ez5.objecttypes = new Objecttypes()).load(),
            ]).done(() => {
                importer = new HeadlessObjecttypeCSVImporter();
                collectionData = data.info.collection.collection;
                importerOpts = {
                    settings: data.info["collection_config"]["csv_import"]["import_settings"]["settings"],
                    collection: collectionData._id,
                    collection_objecttype: collectionData.create_object.objecttype,
                    csv_filename: data.info.file.original_filename,
                    csv_text: csv,
                    debug_mode: CSV_IMPORTER_DEBUG
                }
                try {
                    if(importerOpts.debug_mode) {
                        // For being able to debug the importer we need to restore the console functions
                        console.log = originalConsoleLog;
                        console.info = originalConsoleInfo;
                    }
                    importer.startHeadlessImport(importerOpts).done((report) => {
                        // We imported the csv successfully
                        if(!CUI.util.isEmpty(report)) {
                            processReport(report);
                        }
                        dfr.resolve();
                    }).fail((e) => {
                        finishWithError("CSV Importer failed", e);
                    });
                }
                catch(e) {
                    finishWithError("CSV Importer failed", e);
                }
            });
        });
    });

    return dfr.promise();
}

function processReport(report) {
    data.upload_log ??= [];
    for (const operation in report) {
        operationWord = operation === "insert" ? "inserted" : "updated";
        for (const objecttype in report[operation]) {
            for (const object of report[operation][objecttype])
            {
                data.upload_log.push({
                    operation: operation,
                    objecttype: objecttype,
                    msg: "Object " + object + " was "+ operationWord +" from hotfolder collection csv import",
                    system_object_id: object
                });
            }
        }
    }
}

function finishScript() {
    delete(data.info)
    originalConsoleLog(JSON.stringify({"objects": [] }));
    process.exit(0);
}

function finishWithError(msg, e) {
    delete(data.info);
    if (e && e.message) {
        msg = msg + ": " + e.message;
    }
    data.objects = [];
    data.Error = {
        code: "hotfolder-collection-upload-error",
        error: msg,
        realm: "api",
        statuscode: 400
    }
    originalConsoleLog(JSON.stringify(data));
    process.exit(0);
}
