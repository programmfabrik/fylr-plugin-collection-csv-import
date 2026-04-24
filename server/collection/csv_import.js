const DEBUG_INPUT = false; // Set to true to debug the input and output to a file on /tmp/post-in
const CSV_IMPORTER_DEBUG = false; // Set to true to enable the importer debug mode, this will output objects to log instead of importing them

// Custom event types declared in manifest.master.yml
const EVENT_TYPE_INFO = "COLLECTION_CSV_IMPORT_INFO";
const EVENT_TYPE_WARNING = "COLLECTION_CSV_IMPORT_WARNING";
const EVENT_TYPE_ERROR = "COLLECTION_CSV_IMPORT_ERROR";

// Hard upper bound for a full import run. If it does not settle within this
// budget we force finishWithError rather than letting fylr kill the process
// with a truncated JSON response and no event emitted.
const IMPORT_WATCHDOG_MS = 5 * 60 * 1000;

const fs = require('fs');
const process = require('process');
const path = require('path');
const axios = require('axios');
const jsdom = require('jsdom');

const LOG_FILE = '/tmp/csv_import_debug.log';
let logStream = null;

function initFileLogging() {
    if (CSV_IMPORTER_DEBUG) {
        try {
            logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
            logToFile('=== CSV Import Started at ' + new Date().toISOString() + ' ===');
        } catch (e) {}
    }
}

function logToFile(message, data = null) {
    if (!CSV_IMPORTER_DEBUG || !logStream) return;
    const timestamp = new Date().toISOString();
    let logMessage = `[${timestamp}] ${message}`;
    if (data !== null) {
        try {
            logMessage += '\n' + (typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data));
        } catch (e) {
            logMessage += '\n[Object could not be stringified]';
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

initFileLogging();

// API credentials and event context are cached at parse time so logPluginEvent
// keeps working after finishWithError / finishScript delete data.info from
// the response payload.
let cachedApiUrl = null;
let cachedAccessToken = null;
let cachedEventContext = null;

function cacheEventDataFromInput() {
    try {
        if (data && data.info) {
            cachedApiUrl = data.info.api_url || null;
            cachedAccessToken = data.info.api_user_access_token || null;
        }
        cachedEventContext = buildEventContextFromData();
    } catch (e) {}
}

function buildEventContextFromData() {
    const ctx = {};
    if (!data || !data.info) return ctx;
    if (data.info.file) {
        ctx.file = {
            filename: data.info.file.original_filename,
            extension: data.info.file.extension
        };
    }
    if (data.info.collection && data.info.collection.collection) {
        ctx.collection_id = data.info.collection.collection._id;
    }
    return ctx;
}

function buildEventContext() {
    if (data && data.info) return buildEventContextFromData();
    return cachedEventContext || {};
}

function logPluginEvent(type, info) {
    try {
        if (!cachedApiUrl || !cachedAccessToken) return Promise.resolve();
        const url = cachedApiUrl + "/api/v1/event?access_token=" + cachedAccessToken;
        const payload = { _basetype: "event", event: { type: type, info: info || {} } };
        return axios.post(url, payload, { timeout: 5000 }).catch((err) => {
            logToFile('logPluginEvent: post failed', err && err.message);
        });
    } catch (e) {
        return Promise.resolve();
    }
}

// process.on (not .once) so a second failure during teardown still lands in
// our handler instead of triggering node's default termination and cutting
// off the in-flight error event POST.
if (!CSV_IMPORTER_DEBUG) {
    process.on('uncaughtException', (err) => {
        finishWithError("CSV Importer uncaught exception", err);
    });
    process.on('unhandledRejection', (reason) => {
        const err = reason instanceof Error ? reason : new Error(String(reason));
        finishWithError("CSV Importer unhandled promise rejection", err);
    });
}

global.window = new jsdom.JSDOM(`<!DOCTYPE html>`, { url: "https://example.com/" }).window;
global.window.Error = () => {};
global.alert = () => {};
global.navigator = window.navigator;
global.document = window.document;
global.HTMLElement = window.HTMLElement;
global.HTMLCollection = window.HTMLCollection;
global.NodeList = window.NodeList;
global.Node = window.Node;
global.self = global;
global.window.headless_mode = true;

global.CUI = require('../modules/cui');
global.XMLHttpRequest = XMLHttpRequest = require("xhr2");

const originalConsoleLog = console.log;
const originalConsoleInfo = console.info;
const originalConsoleError = console.error;
console.timeLog = () => {};
console.info = () => {};
if (!CSV_IMPORTER_DEBUG) {
    console.log = () => {};
    console.error = () => {};
}

CUI.Template.loadTemplateFile = () => CUI.resolvedPromise();

const ez5jsPath = path.join(__dirname, '../modules/ez5.js');
const ez5js = fs.readFileSync(ez5jsPath, 'utf8');
// Ez5 is designed to run in the browser, also was coded to run all classes in global scope, so we need to run it in the global scope
// for this we are going to use eval, if we require the ez5.js file it will run in the module scope and we will not have access to the classes
eval(ez5js);

EventPoller = { listen: () => {}, saveEvent: () => {} };

// Plugin loader trampoline: CUI.loadScript is used by ez5 to fetch plugins.
// We fetch via axios and eval in global scope so the evaluated code can
// reach the classes defined by ez5.js.
global.__tempEval = [];
global.tempEvalIndex = -1;
CUI.loadScript = (script) => {
    let dfr = new CUI.Deferred();
    axios.get(script).then((response) => {
        global.tempEvalIndex += 1;
        global.__tempEval[global.tempEvalIndex] = response.data;
        eval('eval(global.__tempEval[global.tempEvalIndex])');
        dfr.resolve();
    }).catch((error) => {
        pluginErrors.push({ error });
        dfr.reject();
    });
    return dfr.promise();
};

// The CSV importer pipeline calls CUI.problem/alert/confirm/toaster at
// several points (e.g. "no rows to import", missing objecttype/mask,
// import toasters). In headless those modals wait forever on user input
// and hang the process. Neutralize them as instant-resolve promises or
// inert stubs so the importer can complete or fail cleanly.
const resolvedCuiPromise = () => {
    const d = new CUI.Deferred();
    d.resolve();
    return d.promise();
};
CUI.problem = resolvedCuiPromise;
CUI.alert = resolvedCuiPromise;
CUI.confirm = resolvedCuiPromise;
CUI.toaster = () => ({ setText: () => {}, destroy: () => {} });

// Auto-confirm 202 responses. fylr uses 202 to ask the user to confirm a
// workflow step (e.g. confirmTransition): the UI renders a modal with
// buttons; in headless we replay the request with the primary/first
// button's name=value appended, mirroring a user click.
if (typeof ServerRequest !== "undefined") {
    ServerRequest.prototype.handle202 = function(dfr, data202) {
        const form_data = {};
        const tasks = (data202 && data202.tasks) || [];
        for (const task of tasks) {
            const buttons = (task && task.buttons) || [];
            for (const btn of buttons) {
                if (btn.hidden && btn.name) form_data[btn.name] = btn.value;
            }
            let picked = buttons.find((b) => !b.hidden && (b.name === "confirmTransition" || b.name === "confirm"));
            if (!picked) picked = buttons.find((b) => !b.hidden && b.name);
            if (picked) form_data[picked.name] = picked.value;
        }
        this.req.url = this.__url;
        this.req.url_data = this._data || {};
        for (const k in form_data) this.req.url_data[k] = form_data[k];
        return this.__doRequest(dfr);
    };
}

let pluginErrors = [];
let info = undefined;
let data = undefined;
let csv_importer_settings = undefined;
let importWatchdogId = null;

if (process.argv.length >= 3) {
    info = JSON.parse(process.argv[2]);
}

let input = '';
process.stdin.on('data', d => {
    try {
        input += d.toString();
    } catch (e) {
        finishWithError("Could not read input into string", e);
    }
});

process.stdin.on('end', () => {
    try {
        data = JSON.parse(input);
        cacheEventDataFromInput();
    } catch (e) {
        finishWithError("Could not parse input JSON", e);
        return;
    }

    if (!data.info["collection_config"]["csv_import"]["enabled"]) {
        finishScript();
        return;
    }

    logPluginEvent(EVENT_TYPE_INFO, Object.assign({ stage: "triggered" }, buildEventContext()));

    try {
        if (DEBUG_INPUT) {
            fs.writeFileSync('/tmp/post-in', input);
            finishScript();
            return;
        }
        global.window.easydb_server_url = data.info.api_url + "/api/v1";
        csv_importer_settings = data.info["collection_config"]["csv_import"]["import_settings"]["settings"];
        if (!csv_importer_settings) {
            finishWithError("No csv_import settings found in the collection config");
            return;
        }
    } catch (e) {
        finishWithError("Could not parse input", e);
        return;
    }

    if (data.info.file.extension !== "csv") {
        logPluginEvent(EVENT_TYPE_INFO, Object.assign({
            stage: "skipped", reason: "not_a_csv_file"
        }, buildEventContext()));
        finishScript();
        return;
    }

    let csvUrl = data.info.file.versions.original.url;
    if (!csvUrl) {
        finishWithError("No csv file url found in the input data");
        return;
    }
    csvUrl += "?access_token=" + data.info.api_user_access_token;

    try {
        axios.get(csvUrl).then((response) => {
            runImporter(response.data).done(() => {
                finishScript();
            }).fail((error) => {
                finishWithError("CSV Importer failed", error);
            });
        }).catch((error) => {
            finishWithError("Error fetching CSV file", error);
        });
    } catch (e) {
        finishWithError("CSV Importer Error", e);
    }
});

function getDailyCollectionName() {
    const now = new Date();
    const day = String(now.getDate()).padStart(2, '0');
    const month = String(now.getMonth() + 1).padStart(2, '0');
    return `${day}-${month}-${now.getFullYear()}`;
}

function searchChildCollection(parentCollectionId, collectionName) {
    let dfr = new CUI.Deferred();
    ez5.api.search({
        type: "POST",
        json_data: {
            type: "collection",
            search: [
                { type: "in", fields: ["collection._id_parent"], in: [parentCollectionId] },
                { type: "match", mode: "fulltext", fields: ["collection.displayname"], string: collectionName }
            ]
        }
    }).done((response) => {
        if (response.objects && response.objects.length > 0) {
            for (const obj of response.objects) {
                const displayname = obj.collection?.displayname;
                if (displayname) {
                    for (const lang in displayname) {
                        if (displayname[lang] === collectionName) {
                            dfr.resolve(obj.collection._id);
                            return;
                        }
                    }
                }
            }
        }
        dfr.resolve(null);
    }).fail(dfr.reject);
    return dfr.promise();
}

function createChildCollection(parentCollectionId, collectionName) {
    let dfr = new CUI.Deferred();
    ez5.api.collection({
        type: "POST",
        json_data: {
            collection: {
                _id_parent: parentCollectionId,
                _version: 1,
                children_allowed: true,
                objects_allowed: true,
                displayname: { "de-DE": collectionName, "en-US": collectionName },
                type: "workfolder",
                webfrontend_props: {}
            }
        }
    }).done((response) => {
        if (response && response.collection) {
            dfr.resolve(response.collection._id);
        } else {
            dfr.reject(new Error("Unexpected response format when creating collection"));
        }
    }).fail(dfr.reject);
    return dfr.promise();
}

function getOrCreateDailySubcollection(parentCollectionId) {
    let dfr = new CUI.Deferred();
    const dailyName = getDailyCollectionName();
    searchChildCollection(parentCollectionId, dailyName).done((existingId) => {
        if (existingId) {
            dfr.resolve(existingId);
        } else {
            createChildCollection(parentCollectionId, dailyName).done(dfr.resolve).fail(dfr.reject);
        }
    }).fail(dfr.reject);
    return dfr.promise();
}

function runImporter(csv) {
    let dfr = new CUI.Deferred();

    importWatchdogId = setTimeout(() => {
        finishWithError("CSV Importer watchdog timeout after " + (IMPORT_WATCHDOG_MS / 1000) + "s");
    }, IMPORT_WATCHDOG_MS);

    ez5.defaults = {
        class: {
            User: User, Group: Group, SystemGroup: SystemGroup,
            AnonymousUser: AnonymousUser, SystemUser: SystemUser
        }
    };

    Localization.prototype.init = () => {};
    Localization.prototype.setLanguage = () => CUI.resolvedPromise();
    AdminMessage.load = () => CUI.resolvedPromise([]);
    ez5.splash.show = () => {};
    ez5.splash.hide = () => {};
    ez5.tray = ez5.rootMenu = {
        registerApp: () => {},
        registerAppLoader: () => {}
    };

    // Return a resolved promise rather than throw: xhr2 on Node swallows
    // synchronous throws from inside xhr callbacks, turning a fatal ez5
    // API error into a silent hang. We emit the event and let the caller's
    // .fail chain propagate the rejection up to the outer dfr.
    ez5.error_handler = (xhr = {}) => {
        let error = "Error executing csv importer ";
        let apiError = null;
        let statusCode = null;
        try {
            statusCode = xhr.status;
            if (xhr.response) {
                apiError = xhr.response.error || xhr.response;
                error += (typeof apiError === "string" ? apiError : JSON.stringify(apiError));
            } else if (typeof xhr.responseText === "string" && xhr.responseText.length > 0) {
                apiError = xhr.responseText;
                error += xhr.responseText;
            }
        } catch (e) {}
        logPluginEvent(EVENT_TYPE_ERROR, Object.assign({
            stage: "ez5_api", message: error, status: statusCode, api_error: apiError
        }, buildEventContext()));
        return CUI.resolvedPromise();
    };

    ez5.session = new Session();
    ez5.settings = { version: "6.11" };
    ez5.tokenParam = "access_token";

    ez5.session_ready().done(() => {
        ez5.session.get(data.info.api_user_access_token).fail((e) => {
            finishWithError("Could not get user session", e);
        }).done(() => {
            (ez5.pluginManager = new PluginManager()).loadPluginInfo().done(() => {
                delete ez5.pluginManager.info.bundle;
                ez5.pluginManager.loadPlugins().always(() => {
                    if (pluginErrors.length > 0) {
                        logPluginEvent(EVENT_TYPE_WARNING, Object.assign({
                            stage: "plugin_load",
                            plugin_errors: pluginErrors.map((p) => ({
                                error: p.error && p.error.message,
                                stack: p.error && p.error.stack
                            }))
                        }, buildEventContext()));
                    }
                    const basePromises = [
                        ez5.schema.load_schema(),
                        (ez5.tagForm = new TagFormSimple()).load(),
                        (ez5.pools = new PoolManagerList()).loadList(),
                        (ez5.objecttypes = new Objecttypes()).load()
                    ];
                    CUI.when(basePromises).done(() => {
                        const importer = new HeadlessObjecttypeCSVImporter();
                        const collectionData = data.info.collection.collection;
                        const addToSubcollection = data.info.collection_config.csv_import.add_to_subcollection !== false;

                        const VALID_IMPORT_MODES = ["both", "insert_only", "update_only"];
                        let importMode = data.info.collection_config.csv_import.import_mode;
                        if (!VALID_IMPORT_MODES.includes(importMode)) importMode = "both";

                        const runImport = (subcollectionId) => {
                            const importerOpts = {
                                settings: data.info["collection_config"]["csv_import"]["import_settings"]["settings"],
                                csv_filename: data.info.file.original_filename,
                                csv_text: csv,
                                debug_mode: CSV_IMPORTER_DEBUG,
                                import_mode: importMode
                            };
                            if (subcollectionId) importerOpts.collection = subcollectionId;
                            try {
                                if (importerOpts.debug_mode) {
                                    console.log = originalConsoleLog;
                                    console.info = originalConsoleInfo;
                                }
                                logPluginEvent(EVENT_TYPE_INFO, Object.assign({
                                    stage: "import_started",
                                    subcollection_id: importerOpts.collection || null,
                                    add_to_subcollection: addToSubcollection,
                                    import_mode: importMode,
                                    csv_size: importerOpts.csv_text.length
                                }, buildEventContext()));
                                importer.startHeadlessImport(importerOpts).done((report) => {
                                    if (!CUI.util.isEmpty(report)) processReport(report);
                                    logPluginEvent(EVENT_TYPE_INFO, Object.assign({
                                        stage: "import_completed",
                                        counts: summarizeReport(report)
                                    }, buildEventContext()));
                                    dfr.resolve();
                                }).fail((e) => {
                                    finishWithError("CSV Importer failed", e);
                                });
                            } catch (e) {
                                finishWithError("CSV Importer failed", e);
                            }
                        };

                        if (addToSubcollection) {
                            getOrCreateDailySubcollection(collectionData._id).done((subcollectionId) => {
                                runImport(subcollectionId);
                            }).fail((e) => {
                                finishWithError("Failed to get or create daily subcollection", e);
                            });
                        } else {
                            runImport(null);
                        }
                    }).fail((e) => {
                        finishWithError("Failed to load base ez5 components", e);
                    });
                });
            }).fail((e) => {
                finishWithError("Failed to load plugin info", e);
            });
        });
    }).fail((e) => {
        finishWithError("ez5 session not ready", e);
    });

    return dfr.promise();
}

function processReport(report) {
    data.upload_log ??= [];
    for (const operation in report) {
        const operationWord = operation === "insert" ? "inserted" : "updated";
        for (const objecttype in report[operation]) {
            for (const object of report[operation][objecttype]) {
                data.upload_log.push({
                    operation: operation,
                    objecttype: objecttype,
                    msg: "Object " + object + " was " + operationWord + " from hotfolder collection csv import",
                    system_object_id: object
                });
            }
        }
    }
}

function summarizeReport(report) {
    const summary = { insert: 0, update: 0, by_objecttype: {} };
    if (!report) return summary;
    for (const operation in report) {
        for (const objecttype in report[operation]) {
            const count = (report[operation][objecttype] || []).length;
            summary[operation] = (summary[operation] || 0) + count;
            summary.by_objecttype[objecttype] ??= {};
            summary.by_objecttype[objecttype][operation] = count;
        }
    }
    return summary;
}

// process.exit does not guarantee stdout is flushed before the process
// ends, and fylr reads the response over a pipe - exiting mid-write
// surfaces on the server as an "unexpected EOF" JSON parse error. Wait
// for the write's drain callback before exiting.
function writeResponseAndExit(payload) {
    let exited = false;
    const doExit = () => {
        if (exited) return;
        exited = true;
        process.exit(0);
    };
    const serialized = JSON.stringify(payload) + "\n";
    try {
        const flushed = process.stdout.write(serialized, doExit);
        if (!flushed) process.stdout.once('drain', doExit);
        setTimeout(doExit, 5000);
    } catch (e) {
        doExit();
    }
}

function finishScript() {
    if (importWatchdogId) { clearTimeout(importWatchdogId); importWatchdogId = null; }
    delete(data.info);
    const outData = { objects: [] };
    if (data.upload_log) outData.upload_log = data.upload_log;
    closeFileLogging();
    writeResponseAndExit(outData);
}

let finishWithErrorCalled = false;
function finishWithError(msg, e) {
    if (finishWithErrorCalled) return;
    finishWithErrorCalled = true;
    if (importWatchdogId) { clearTimeout(importWatchdogId); importWatchdogId = null; }
    if (!data) data = {};

    const eventContext = buildEventContext();
    if (data.info) delete(data.info);

    if (e && e.message) msg = msg + ": " + e.message;
    else if (e) msg = msg + ": " + JSON.stringify(e);

    let plugin_errors = null;
    if (pluginErrors.length > 0) {
        msg = msg + " there were plugin errors.";
        plugin_errors = pluginErrors.map((p) => ({
            error: p.error && p.error.message,
            stack: p.error && p.error.stack
        }));
    }
    data.objects = [];
    data.Error = {
        code: "hotfolder-collection-upload-error",
        error: msg,
        realm: "api",
        statuscode: 400
    };

    const end = () => {
        closeFileLogging();
        writeResponseAndExit(data);
    };
    Promise.resolve(logPluginEvent(EVENT_TYPE_ERROR, Object.assign({
        stage: "finish_with_error",
        error: msg,
        stack: e ? e.stack : null,
        plugin_errors: plugin_errors
    }, eventContext))).then(end, end);
}
