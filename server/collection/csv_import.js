const DEBUG_INPUT = false; // Set to true to debug the input and output to a file on /tmp/post-in
const CSV_IMPORTER_DEBUG = false; // Set to true to enable the importer debug mode, this will output objects to log instead of importing them

const fs = require('fs');
const process = require('process');
const path = require('path');
const axios = require('axios');
const jsdom = require('jsdom');

// This allows us to catch uncaught exceptions and finish the script in a way that the frontend can get the error
// If we let the uncaught exception the script will exit with code 1 and the frontend will not be able to get the error
// This is important to be able to debug the script on instances where we can't see the console output
if(!CSV_IMPORTER_DEBUG)
{
    process.once('uncaughtException', (err) => {
        finishWithError("CSV Importer Exited with error", err);
    });
}
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
const originalConsoleError = console.error;
console.timeLog = () => {};
console.info = () => {};
if(!CSV_IMPORTER_DEBUG)
{
    console.log = () => {};
    console.error = () => {};
}

CUI.Template.loadTemplateFile = () => {
    return CUI.resolvedPromise();
};

// Run headless ez5
const ez5jsPath = path.join(__dirname, '../modules/ez5.js');
const ez5js = fs.readFileSync(ez5jsPath, 'utf8');

//const ez5js = fs.readFileSync('../modules/easydb-webfrontend/build/web/js/easydb5.js', 'utf8');
// Ez5 is designed to run in the browser, also was coded to run all classes in global scope, so we need to run it in the global scope
// for this we are going to use eval, if we require the ez5.js file it will run in the module scope and we will not have access to the classes
eval(ez5js);

EventPoller = {
    listen: () => {},
    saveEvent: () => {}
};


// Mock the eval function to be able to load the scripts in the global scope
global.__tempEval = []; // Array to store the scripts to be evaluated
global.tempEvalIndex = -1; // Index to the last script evaluated
CUI.loadScript = (script) => {
    // Load the script in the global scope
    let dfr = new CUI.Deferred();
    axios.get(script).then((response) => {
        global.tempEvalIndex += 1;
        const scriptContent = response.data;
        global.__tempEval[global.tempEvalIndex] = scriptContent;
        // This is a hack to be able to evaluate the script in the global scope
        // If not the plugins will not be able to access the global scope classes from the ez5 evaluated code.
        eval('eval(global.__tempEval[global.tempEvalIndex])');
        if(CSV_IMPORTER_DEBUG) console.log("Loaded script: " + script);
        dfr.resolve();
    }).catch((error) => {
        pluginErrors.push({error});
        dfr.reject();
    });
    return dfr.promise();
};


let pluginErrors = [];
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
            finishWithError("No csv_import settings found in the collection config")
        }
    } catch(e) {
        finishWithError("Could not parse input", e);
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
    try {
        axios.get(csvUrl).then((response) => {
            // Run the importer
            runImporter(response.data).done(() => {
                finishScript();
            }).fail((error) => {
                throw error;
            });
        })
    } catch(e) {
        finishWithError("CSV Importer Error", e);
    }
});

function runImporter(csv) {
    let dfr = new CUI.Deferred();

    // Important ez5 needs the default classes to be set in the ez5 object
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
    AdminMessage.load = () => { return CUI.resolvedPromise([])};
    ez5.splash.show = () => {};
    ez5.splash.hide = () => {};

    // Mock the tray and rootMenu on headless mode
    ez5.tray = ez5.rootMenu = {
        registerApp: () => {},
        registerAppLoader: () => {}
    }

    // Mock the ez5 error handler to get api and other wrrrors from ez5 code.
    ez5.error_handler = (xhr = {}) => {
        error = "Error executing csv importer "
        if(xhr.response){
            error += xhr.response.error
        }
        throw new Error(error);
    }

    //Start the ez5 app
    ez5.session = new Session();
    ez5.settings = {
        version: "6.11"
    };

    // This parameter indicates how the access token is going to be passed to the api on ez5 api classes
    ez5.tokenParam = "access_token";

    ez5.session_ready().done( () => {
        // First of all we get the user session.
        ez5.session.get(data.info.api_user_access_token).fail( (e) => {
            dfr.reject(new Error("Could not get user session"));
        }).done((response, xhr) => {
            // We need to load the plugins to be able to run the importer
            (ez5.pluginManager = new PluginManager()).loadPluginInfo().done( () => {
                // We cannot use the plugin bundle, if one error occour in one of the plugins then all the bundle will fail
                // So we force ez5 to load the plugins one by one removing the bundle from the info.
                delete ez5.pluginManager.info.bundle;
                // We mocked the loadScript function to load the scripts in the global scope above on this file.
                // We continue also when there are errors loading the plugins.
                ez5.pluginManager.loadPlugins().always( () => {
                    // Init all the base classes for the correct execution of the importer
                    basePromises = [
                        ez5.schema.load_schema(),
                        (ez5.tagForm = new TagFormSimple()).load(),
                        (ez5.pools = new PoolManagerList()).loadList(),
                        (ez5.objecttypes = new Objecttypes()).load()
                    ];
                    CUI.when(basePromises).done(() => {
                        // Now we have a running ez5 app and we can run the importer class.
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
    outData = { "objects": [] }
    if(data.upload_log) {
        outData.upload_log = data.upload_log
    }
    originalConsoleLog(JSON.stringify(outData));
    process.exit(0);
}

function finishWithError(msg, e) {
    let end = () => {
        originalConsoleLog(JSON.stringify(data));
        process.exit(0);
    }
    delete(data.info);
    if (e && e.message) {
        msg = msg + ": " + e.message;
    } else if (e) {
        msg = msg + ": " + JSON.stringify(e)
    }

    let plugin_errors = null;
    if( pluginErrors.length > 0) {
        msg = msg + " there were plugin errors. Check the logs for more information.";
        plugin_errors = [];
        for (let i = 0; i < pluginErrors.length; i++) {
            plugin_errors.push({
                error: pluginErrors[i].error.message,
                stack: pluginErrors[i].error.stack
            });
        }
        debugger;
    }
    data.objects = [];
    data.Error = {
        code: "hotfolder-collection-upload-error",
        error: msg,
        realm: "api",
        statuscode: 400
    }
    try {
        ez5.api.event({
            type: "POST",
            json_data: {
                event: {
                    type: "FRONTEND_ERROR",
                    info: {
                        error: msg,
                        stack: e ? e.stack : null,
                        plugins_errors: plugin_errors
                    }
                }
            }
        }).done(() => {
            end();
        })
    } catch (e) {
        end();
    }


}
