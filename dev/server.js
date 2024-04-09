/*
This file is for testing purposes only. It is not intended to be used in production.
This file lets you test the execution of the csv-import plugin from the command line directly.

Yoy need a valid input file to test this script.

 */
const { spawn } = require('child_process');
const fs = require('fs');

//const scriptPath = '../server/collection/csv_import.js';
const scriptPath = '../build/collection-csv-import/server/collection/csv_import.js';
const scriptInputFile = 'input.json';

const inputData = fs.readFileSync(scriptInputFile, 'utf8');


const childProcess = spawn('node', [scriptPath], { stdio: ['pipe', 'pipe', 'pipe'] });

childProcess.stdin.write(inputData);
childProcess.stdin.end();

childProcess.stdout.on('data', (data) => {
    console.log(`stdout: ${data}`);
});

childProcess.stderr.on('data', (data) => {
    console.error(`stderr: ${data}`);
});

childProcess.on('close', (code) => {
    console.log(`child process exited with code ${code}`);
});
