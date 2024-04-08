const fs = require('fs');
const axios = require('axios');

// Mocks the DOM to be able to require CUI.
require("../../modules/cui-dom-mock");
// CUI is required in the headless ez5.js
global.CUI = require('../../modules/easydb-webfrontend/build/headless/cui');
// We need xhr2 to pollyfill the XMLHttpRequest object, xmlhttprequest is not available in node and is used by CUI and ez5
global.XMLHttpRequest = XMLHttpRequest = require("xhr2");


// We need to indicate ez5 that we are in headless mode and the server url
global.window.headless_mode = true;
global.window.easydb_server_url = "http://localhost/api/v1";

// Run headless ez5
const ez5js = fs.readFileSync('../modules/easydb-webfrontend/build/headless/ez5.js', 'utf8');
//const ez5js = fs.readFileSync('../modules/easydb-webfrontend/build/web/js/easydb5.js', 'utf8');
// Ez5 is designed to run in the browser, also was coded to run all classes in global scope, so we need to run it in the global scope
// for this we are going to use eval, if we require the ez5.js file it will run in the module scope and we will not have access to the classes
eval(ez5js);




let info = undefined
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
    let data;
    try {
        //fs.writeFileSync('/tmp/post-in', input);
        data = JSON.parse(input);
    } catch(e) {
        console.error(`Could not parse input: ${e.message}`, e.stack);
        process.exit(1);
    }

    EventPoller = {
        listen: () => {}
    };
    ez5.defaults = {
        class: {
            User: User,
            Group: Group,
            SystemGroup: SystemGroup,
            AnonymousUser: AnonymousUser,
            SystemUser: SystemUser
        }
    }
    Localization.prototype.init = () => {};
    Localization.prototype.setLanguage = () => { return CUI.resolvedPromise()};
    ez5.rootMenu = {
        registerApp: () => {}
    }
    ez5.session = new Session();
    ez5.settings = {
        version: "6.10"
    };
    ez5.tokenParam = "access_token";
    ez5.session_ready().done( () => {
        console.log("Session ready");
        ez5.session.get(data.info.api_user_access_token).fail( (e) => {
            console.error("Could not get user session", e);
        }).done((response, xhr) => {
            console.log("Session returned ok");
            ez5.schema.load_schema().done(() => {
                console.log("Schema loaded");
                console.log(ez5.schema);
                process.exit(0);
            });
        });
    });



    // let modified = false
    //
    // // Check that we are uploading a csv file
    // if (data.info.file.extension !== "csv") {
    //     console.error("This plugin only works with CSV files");
    //     process.exit(0);
    // }
    //
    // const csvUrl = data.info.file.versions.original.url + "?access_token=" + data.info.api_user_access_token
    // // Get the csv from the server , we use the access token included in info
    // axios.get(csvUrl).then((response) => {
    //     console.log(response.data);
    //     delete(data.info)
    //     console.log(JSON.stringify(data));
    // }).catch((error) => {
    //     console.error("Could not get the csv file");
    //     process.exit(0);
    // });

});
