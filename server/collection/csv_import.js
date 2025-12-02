const DEBUG_INPUT = false; // Set to true to debug the input and output to a file on /tmp/post-in
const CSV_IMPORTER_DEBUG = false; // Set to true to enable the importer debug mode, this will output objects to log instead of importing them

const fs = require('fs');
const process = require('process');
const path = require('path');
const axios = require('axios');
const jsdom = require('jsdom');

// File logging setup - enabled when CSV_IMPORTER_DEBUG is true
const LOG_FILE = '/tmp/csv_import_debug.log';
let logStream = null;

function initFileLogging() {
    if (CSV_IMPORTER_DEBUG) {
        try {
            logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
            logToFile('=== CSV Import Started at ' + new Date().toISOString() + ' ===');
        } catch (e) {
            // Silent fail if we can't create log file
        }
    }
}

function logToFile(message, data = null) {
    if (!CSV_IMPORTER_DEBUG || !logStream) return;

    const timestamp = new Date().toISOString();
    let logMessage = `[${timestamp}] ${message}`;

    if (data !== null) {
        if (typeof data === 'object') {
            try {
                logMessage += '\n' + JSON.stringify(data, null, 2);
            } catch (e) {
                logMessage += '\n[Object could not be stringified: ' + e.message + ']';
            }
        } else {
            logMessage += '\n' + String(data);
        }
    }

    logStream.write(logMessage + '\n');
}

function closeFileLogging() {
    if (logStream) {
        logToFile('=== CSV Import Ended ===\n');
        logStream.end();
    }
}

// Initialize file logging
initFileLogging();

// This allows us to catch uncaught exceptions and finish the script in a way that the frontend can get the error
// If we let the uncaught exception the script will exit with code 1 and the frontend will not be able to get the error
// This is important to be able to debug the script on instances where we can't see the console output
if(!CSV_IMPORTER_DEBUG)
{
    process.once('uncaughtException', (err) => {
        logToFile('UNCAUGHT EXCEPTION:', err);
        logToFile('Stack trace:', err.stack);
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
logToFile('Waiting for stdin data...');
process.stdin.on('data', d => {
    try {
        input += d.toString();
        logToFile('Received stdin data chunk, total length:', input.length);
    } catch(e) {
        logToFile('ERROR reading stdin:', e);
        console.error(`Could not read input into string: ${e.message}`, e.stack);
        process.exit(1);
    }
});


process.stdin.on('end', () => {
    logToFile('Stdin ended, parsing input data...');

    try {
        data = JSON.parse(input);
        logToFile('Input data parsed successfully');
        logToFile('Data structure:', {
            hasInfo: !!data.info,
            hasCollectionConfig: !!(data.info && data.info.collection_config),
            hasCsvImport: !!(data.info && data.info.collection_config && data.info.collection_config.csv_import)
        });
    } catch(e) {
        logToFile('ERROR parsing input JSON:', e);
        finishWithError("Could not parse input JSON", e);
        return;
    }

    if(!data.info["collection_config"]["csv_import"]["enabled"])
    {
        logToFile('CSV import is not enabled, finishing script');
        // If the csv import is not enabled we finish the script
        finishScript();
        return;
    }

    try {
        if(DEBUG_INPUT)
        {
            logToFile('DEBUG_INPUT is enabled, writing to /tmp/post-in');
            // If debug input is set then we output the input to a file and we allow the upload of the file
            fs.writeFileSync('/tmp/post-in', input);
            data = JSON.parse(input);
            finishScript();
            return;
        }

        global.window.easydb_server_url = data.info.api_url + "/api/v1";
        logToFile('Server URL set to:', global.window.easydb_server_url);

        csv_importer_settings = data.info["collection_config"]["csv_import"]["import_settings"]["settings"];
        if (!csv_importer_settings) {
            logToFile('ERROR: No csv_import settings found');
            finishWithError("No csv_import settings found in the collection config")
            return;
        }
        logToFile('CSV importer settings loaded successfully');
    } catch(e) {
        logToFile('ERROR during initialization:', e);
        finishWithError("Could not parse input", e);
        return;
    }

    // Check that we are uploading a csv file
    if (data.info.file.extension !== "csv") {
        logToFile('File is not CSV (extension: ' + data.info.file.extension + '), finishing script');
        finishScript();
        return;
    }

    let csvUrl = data.info.file.versions.original.url;
    if(!csvUrl) {
        logToFile('ERROR: No CSV file URL found');
        finishWithError("No csv file url found in the input data");
        return;
    }
    csvUrl += "?access_token=" + data.info.api_user_access_token
    logToFile('Fetching CSV from URL:', csvUrl.replace(/access_token=[^&]+/, 'access_token=***'));

    // Get the csv from the server , we use the access token included in info
    try {
        axios.get(csvUrl).then((response) => {
            logToFile('CSV fetched successfully, size:', response.data.length);
            // Run the importer
            runImporter(response.data).done(() => {
                logToFile('Importer finished successfully');
                finishScript();
            }).fail((error) => {
                logToFile('Importer failed:', error);
                throw error;
            });
        }).catch((error) => {
            logToFile('ERROR fetching CSV:', error);
            finishWithError("Error fetching CSV file", error);
        });
    } catch(e) {
        logToFile('ERROR in axios.get:', e);
        finishWithError("CSV Importer Error", e);
    }
});

/**
 * Generates the daily subcollection name in format DD-MM-YYYY
 */
function getDailyCollectionName() {
    const now = new Date();
    const day = String(now.getDate()).padStart(2, '0');
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const year = now.getFullYear();
    return `${day}-${month}-${year}`;
}

/**
 * Searches for a child collection with a specific name under a parent collection
 */
function searchChildCollection(parentCollectionId, collectionName) {
    logToFile('searchChildCollection() called', { parentCollectionId, collectionName });
    let dfr = new CUI.Deferred();

    const searchBody = {
        type: "collection",
        search: [
            {
                type: "in",
                fields: ["collection._id_parent"],
                in: [parentCollectionId]
            },
            {
                type: "match",
                mode: "fulltext",
                fields: ["collection.displayname"],
                string: collectionName
            }
        ]
    };

    logToFile('Search request body:', searchBody);

    ez5.api.search({
        type: "POST",
        json_data: searchBody
    }).done((response) => {
        logToFile('Search response received:', response);
        if (response.objects && response.objects.length > 0) {
            // Find exact match by checking displayname values
            for (const obj of response.objects) {
                const displayname = obj.collection?.displayname;
                if (displayname) {
                    for (const lang in displayname) {
                        if (displayname[lang] === collectionName) {
                            logToFile('Found matching collection:', obj.collection._id);
                            dfr.resolve(obj.collection._id);
                            return;
                        }
                    }
                }
            }
        }
        logToFile('No matching collection found');
        dfr.resolve(null);
    }).fail((error) => {
        logToFile('Search failed:', error);
        dfr.reject(error);
    });

    return dfr.promise();
}

/**
 * Creates a child collection under a parent collection
 */
function createChildCollection(parentCollectionId, collectionName) {
    logToFile('createChildCollection() called', { parentCollectionId, collectionName });
    let dfr = new CUI.Deferred();

    const collectionBody = {
        collection: {
            _id_parent: parentCollectionId,
            _version: 1,
            children_allowed: true,
            objects_allowed: true,
            displayname: {
                "de-DE": collectionName,
                "en-US": collectionName
            },
            type: "workfolder",
            webfrontend_props: {}
        }
    };

    logToFile('Create collection request body:', collectionBody);

    ez5.api.collection({
        type: "POST",
        json_data: collectionBody
    }).done((response) => {
        logToFile('Create collection response:', response);
        if (response && response.collection) {
            const newCollectionId = response.collection._id;
            logToFile('Created new collection with ID:', newCollectionId);
            dfr.resolve(newCollectionId);
        } else {
            logToFile('Unexpected response format when creating collection');
            dfr.reject(new Error("Unexpected response format when creating collection"));
        }
    }).fail((error) => {
        logToFile('Create collection failed:', error);
        dfr.reject(error);
    });

    return dfr.promise();
}

/**
 * Gets or creates a daily subcollection for the current date
 */
function getOrCreateDailySubcollection(parentCollectionId) {
    logToFile('getOrCreateDailySubcollection() called', { parentCollectionId });
    let dfr = new CUI.Deferred();

    const dailyName = getDailyCollectionName();
    logToFile('Daily collection name:', dailyName);

    searchChildCollection(parentCollectionId, dailyName).done((existingCollectionId) => {
        if (existingCollectionId) {
            logToFile('Using existing daily subcollection:', existingCollectionId);
            dfr.resolve(existingCollectionId);
        } else {
            logToFile('Creating new daily subcollection...');
            createChildCollection(parentCollectionId, dailyName).done((newCollectionId) => {
                logToFile('Created new daily subcollection:', newCollectionId);
                dfr.resolve(newCollectionId);
            }).fail((error) => {
                dfr.reject(error);
            });
        }
    }).fail((error) => {
        dfr.reject(error);
    });

    return dfr.promise();
}

function runImporter(csv) {
    logToFile('runImporter() called');
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
    logToFile('ez5 defaults set');

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
        logToFile('ez5.error_handler called:', error);
        throw new Error(error);
    }

    //Start the ez5 app
    ez5.session = new Session();
    ez5.settings = {
        version: "6.11"
    };

    // This parameter indicates how the access token is going to be passed to the api on ez5 api classes
    ez5.tokenParam = "access_token";
    logToFile('ez5 session and settings initialized');

    ez5.session_ready().done( () => {
        logToFile('ez5.session_ready() completed');
        // First of all we get the user session.
        ez5.session.get(data.info.api_user_access_token).fail( (e) => {
            logToFile('ERROR: Could not get user session:', e);
            dfr.reject(new Error("Could not get user session"));
        }).done((response, xhr) => {
            logToFile('User session obtained successfully');
            // We need to load the plugins to be able to run the importer
            (ez5.pluginManager = new PluginManager()).loadPluginInfo().done( () => {
                logToFile('Plugin info loaded successfully');
                // We cannot use the plugin bundle, if one error occour in one of the plugins then all the bundle will fail
                // So we force ez5 to load the plugins one by one removing the bundle from the info.
                delete ez5.pluginManager.info.bundle;
                // We mocked the loadScript function to load the scripts in the global scope above on this file.
                // We continue also when there are errors loading the plugins.
                ez5.pluginManager.loadPlugins().always( () => {
                    logToFile('Plugins loaded (with or without errors)');
                    if (pluginErrors.length > 0) {
                        logToFile('Plugin errors detected:', pluginErrors);
                    }
                    // Init all the base classes for the correct execution of the importer
                    basePromises = [
                        ez5.schema.load_schema(),
                        (ez5.tagForm = new TagFormSimple()).load(),
                        (ez5.pools = new PoolManagerList()).loadList(),
                        (ez5.objecttypes = new Objecttypes()).load()
                    ];
                    logToFile('Loading base promises (schema, tagForm, pools, objecttypes)...');
                    CUI.when(basePromises).done(() => {
                        logToFile('Base promises loaded successfully');
                        // Now we have a running ez5 app and we can run the importer class.
                        importer = new HeadlessObjecttypeCSVImporter();
                        collectionData = data.info.collection.collection;

                        // Get or create the daily subcollection for imports
                        getOrCreateDailySubcollection(collectionData._id).done((subcollectionId) => {
                            logToFile('Using subcollection ID for import:', subcollectionId);

                            importerOpts = {
                                settings: data.info["collection_config"]["csv_import"]["import_settings"]["settings"],
                                collection:subcollectionId, // WWe use the subcollection for the import
                                collection_objecttype: collectionData.create_object.objecttype,
                                csv_filename: data.info.file.original_filename,
                                csv_text: csv,
                                debug_mode: CSV_IMPORTER_DEBUG
                            }
                            logToFile('Importer options:', {
                                collection: importerOpts.collection,
                                collection_objecttype: importerOpts.collection_objecttype,
                                csv_filename: importerOpts.csv_filename,
                                csv_text_length: importerOpts.csv_text.length,
                                debug_mode: importerOpts.debug_mode
                            });
                            try {
                                if(importerOpts.debug_mode) {
                                    // For being able to debug the importer we need to restore the console functions
                                    console.log = originalConsoleLog;
                                    console.info = originalConsoleInfo;
                                }
                                logToFile('Starting headless import...');
                                importer.startHeadlessImport(importerOpts).done((report) => {
                                    logToFile('Import completed successfully');
                                    // We imported the csv successfully
                                    if(!CUI.util.isEmpty(report)) {
                                        logToFile('Processing report:', report);
                                        processReport(report);
                                    }
                                    dfr.resolve();
                                }).fail((e) => {
                                    logToFile('Import failed:', e);
                                    finishWithError("CSV Importer failed", e);
                                });
                            }
                            catch(e) {
                                logToFile('Exception during import:', e);
                                finishWithError("CSV Importer failed", e);
                            }
                        }).fail((e) => {
                            logToFile('ERROR getting/creating daily subcollection:', e);
                            finishWithError("Failed to get or create daily subcollection", e);
                        });
                    }).fail((e) => {
                        logToFile('ERROR loading base promises:', e);
                        finishWithError("Failed to load base ez5 components", e);
                    });
                });
            }).fail((e) => {
                logToFile('ERROR loading plugin info:', e);
                finishWithError("Failed to load plugin info", e);
            });

        });
    }).fail((e) => {
        logToFile('ERROR in ez5.session_ready():', e);
        finishWithError("ez5 session not ready", e);
    });

    return dfr.promise();
}

function processReport(report) {
    logToFile('processReport() called');
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
    logToFile('Report processed, upload_log entries:', data.upload_log.length);
}

function finishScript() {
    logToFile('finishScript() called - SUCCESS');
    delete(data.info)
    outData = { "objects": [] }
    if(data.upload_log) {
        outData.upload_log = data.upload_log
    }
    logToFile('Output data:', outData);
    closeFileLogging();
    originalConsoleLog(JSON.stringify(outData));
    process.exit(0);
}

function finishWithError(msg, e) {
    logToFile('finishWithError() called');
    logToFile('Error message:', msg);
    if (e) {
        logToFile('Error object:', e);
        if (e.stack) {
            logToFile('Error stack:', e.stack);
        }
    }

    let end = () => {
        logToFile('Ending with error, output data:', data);
        closeFileLogging();
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
        logToFile('Plugin errors found:', pluginErrors.length);
        msg = msg + " there were plugin errors. Check the logs for more information.";
        plugin_errors = [];
        for (let i = 0; i < pluginErrors.length; i++) {
            plugin_errors.push({
                error: pluginErrors[i].error.message,
                stack: pluginErrors[i].error.stack
            });
        }
        logToFile('Plugin errors details:', plugin_errors);
    }
    data.objects = [];
    data.Error = {
        code: "hotfolder-collection-upload-error",
        error: msg,
        realm: "api",
        statuscode: 400
    }
    logToFile('Final error object:', data.Error);
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
            logToFile('Error event posted successfully');
            end();
        }).fail((eventError) => {
            logToFile('Failed to post error event:', eventError);
            end();
        });
    } catch (e) {
        logToFile('Exception while posting error event:', e);
        end();
    }
}
