

import { MongoClient } from 'mongodb';
const { spawn, exec } = require('child_process');

import os from 'os'


export async function startDB(){
    try {
        console.log("Checking for DB")
        const isInstalled = await checkMongoDBInstallation();
        if (!isInstalled) {
            console.log("Installing Mongo")
            await installMongoDB();
        } else {
            console.log('MongoDB is already installed.');
        }
    } catch (error) {
        console.error('Error:', error);
    }

    // return db
    // const uri = 'your_mongodb_connection_string';

    // MongoClient.connect(uri, { useNewUrlParser: true, useUnifiedTopology: true })
    // .then(client => {
    //     const db = client.db('test');
    //     collection = db.collection('documents');
    //     console.log('Connected to MongoDB');
    // })
    // .catch(error => console.error('Failed to connect to MongoDB:', error));

}

function checkMongoDBInstallation() {
    return new Promise((resolve, reject) => {
        const process = spawn('mongod', ['--version']);

        process.on('error', (err: any) => {
            resolve(false);
        });

        process.stdout.on('data', (data: any) => {
            console.log(`MongoDB is already installed: ${data}`);
            resolve(true);
        });

        process.stderr.on('data', (data: any) => {
            resolve(false);
        });

        process.on('close', (code: any) => {
            if (code !== 0) {
                resolve(false);
            }
        });
    });
}

function installMongoDB() {
    return new Promise((resolve, reject) => {
        console.log('Installing MongoDB...');
        let command;
        let args;

        const type = os.type()
        switch (type) {
          case 'Linux':
                command = 'bash';
                args = ['-c', `
                    wget -qO - https://www.mongodb.org/static/pgp/server-4.4.asc | sudo apt-key add - &&
                    echo "deb [ arch=amd64,arm64 ] https://repo.mongodb.org/apt/ubuntu $(lsb_release -cs)/mongodb-org/4.4 multiverse" | sudo tee /etc/apt/sources.list.d/mongodb-org-4.4.list &&
                    sudo apt-get update &&
                    sudo apt-get install -y mongodb-org
                `];
                break;
          case 'Windows_NT':
            command = 'powershell.exe';
            args = ['-Command', 'choco install mongodb -y'];
            break;
          //case 'Darwin':
          default:
            throw new Error('no os?')

        }

        const process = spawn(command, args);

        process.stdout.on('data', (data: any) => {
            console.log(`stdout: ${data}`);
        });

        process.stderr.on('data', (data) => {
            console.error(`stderr: ${data}`);
        });

        process.on('close', (code) => {
            if (code === 0) {
                console.log('MongoDB installed successfully.');
                resolve();
            } else {
                reject(new Error(`Installation failed with code ${code}`));
            }
        });
    });
}