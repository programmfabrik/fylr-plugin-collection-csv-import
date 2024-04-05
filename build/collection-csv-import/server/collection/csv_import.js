const fs = require('fs');
const axios = require('axios');

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

    let modified = false

    // Check that we are uploading a csv file
    if (data.info.file.extension !== "csv") {
        console.error("This plugin only works with CSV files");
        process.exit(0);
    }

    const csvUrl = data.info.file.versions.original.url + "?access_token=" + data.info.api_user_access_token
    // Get the csv from the server , we use the access token included in info
    axios.get(csvUrl).then((response) => {
        console.log(response.data);
        delete(data.info)
        console.log(JSON.stringify(data));
    }).catch((error) => {
        console.error("Could not get the csv file");
        process.exit(0);
    });

});
