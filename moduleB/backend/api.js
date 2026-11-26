'use strict';

const cors = require("cors");
const express = require("express");
const grpc = require( "@grpc/grpc-js");
const fabric = require("@hyperledger/fabric-gateway");
const childProcess = require("child_process");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");

const FABRIC_SAMPLES_PATH = path.resolve(__dirname, "../../fabric-samples");
const ORGANIZATIONS_PATH = FABRIC_SAMPLES_PATH + "/test-network/organizations";

const ORGS = {
    org1: { msp: "org1MSP"  , peer: "localhost:7051"  ,    caPort: 7054    }, // операторы
    org2: { msp: "org2MSP"  , peer: "localhost:9051"  ,    caPort: 8054    }, // производители
    // org3: { msp: "org3MSP"  , peer: "localhost:11051" , /* caPort: 9054  */}, // дистрибуторы
    // org4: { msp: "org4MSP"/*, peer: "localhost:13051" ,    caPort: 10054 */}  // клиенты
}

const sessions = new Map();

function runCommand(org, args){
    const env = Object.assign({}, process.env, {
        FABRIC_CA_CLIENT_HOME: ORGANIZATIONS_PATH + "/peerOrganizations/" + org + ".example.com"
    });
    const commandArgs = ["--caname", "ca-" + org, "--tls.certfiles", ORGANIZATIONS_PATH + "/fabric-ca/" + org + "/ca-cert.pem"];
    try{
        childProcess.execFileSync(FABRIC_SAMPLES_PATH + "/bin/fabric-ca-client", args.concat(commandArgs), {env:env});
    }
    catch(e){
        throw new Error(e.message)
    }
}

function register(org, name, password){
    runCommand(
        org,
        ["register", "--id.name", name, "--id.secret", password, "--id.type", "client"]
    )
}

function login(org, name, password){
    console.log("login ________1__________")
    const url = "https://" + encodeURIComponent(name) + ":" + encodeURIComponent(password) + "@localhost:" + ORGS[org].caPort;
        console.log("_____2______")
    const USERMSP_PATH = ORGANIZATIONS_PATH + "/peerOrganizations/" + org  + ".example.com/users/" + name + "@" + org + ".example.com/msp"
        console.log("_____3______")
    runCommand(
        org,
        ["enroll", "-u", url, "-M", USERMSP_PATH]
    )
        console.log("_____4______")
    const keyFile = fs.readdirSync(USERMSP_PATH + "/keystore")[0];
        console.log("_____5______")
    const token = crypto.randomUUID();
        console.log("_____6______")
    sessions.set( 
        token,
        {
            org: org,
            certificate: fs.readFileSync(USERMSP_PATH + "/signcerts/cert.pem"),
            privateKey: crypto.createPrivateKey(fs.readFileSync(USERMSP_PATH + "/keystore/" + keyFile))
        }
    );
        console.log("end login_____7______")
    return token;
}

const clients = {};
function grpcClient(org){
    console.log("grpc _____1_____")
    const tlsCert = fs.readFileSync(ORGANIZATIONS_PATH + "/peerOrganizations/" + org + ".example.com/tlsca/tlsca." + org + ".example.com-cert.pem");
    console.log("_____2_____")
    if(!clients[org] || !clients[org].tlsCert.equals(tlsCert)){
        console.log("_____3_____")
        if(clients[org]) 
            clients[org].client.close()
        console.log("_____4_____")
        clients[org] = {
            tlsCert: tlsCert,
            client: new grpc.Client(ORGS[org].peer, grpc.credentials.createSsl(tlsCert), {
                "grpc.ssl_target_name_override": "peer0." + org + ".example.com"
            })
        };
        console.log("end grpc_____5_____")
    }
    return clients[org].client;
}

async function callContract(type, token, method, args){
    console.log("contract ______1______")
    const user = sessions.get(token);
    console.log("______2______")
    if(!user){
        console.log("contract error______3______")
        throw new Error("требуется вход")
    }
    console.log("______4______")
    const gateway = fabric.connect({
        client: grpcClient(user.org),
        identity: { mspId: ORGS[user.org].msp, credentials: user.certificate},
        signer: fabric.signers.newPrivateKeySigner(user.privateKey),
        hash: fabric.hash.sha256
    })
    console.log("______5______")
    try{
        console.log("______6______")
        const contract = gateway.getNetwork("mychannel").getContract("basic");
        console.log(`______7______ method ${method}, args:${JSON.stringify(args)}`)
        const result = type === "submit" ? 
            await contract.submit  (method, {arguments: args}) :
            await contract.evaluate(method, {arguments: args})
        console.log("______8______")
        return JSON.parse(Buffer.from(result).toString());
    }
    catch(e){
        console.log("contract error______9______" + e.toString())
        throw new Error(e);
    }
    finally{
        console.log("end contract______10______")
        gateway.close();
    }
}

const app = express();

app.use(cors());
app.use(express.json());

app.post("/register", async (req, res) => {
    try{
        console.log("_____1______")
        register(req.body.org, req.body.name, req.body.password);
        console.log("_____2______")
        const token = login(req.body.org, req.body.name, req.body.password);
        console.log("_____3______")
        await callContract("submit", token, "addUser", [req.body.org, req.body.name, req.body.producingRegions, req.body.availableRegions, req.body.currentRegion, req.body.desc] )
        console.log("_____4______")
        res.json({token: token})
    }
    catch(e){
        res.status(400).json({error: e.message})
    }
})

app.post("/login", (req, res) => {
    try {
        res.json({ token: login(req.body.org, req.body.name, req.body.password) });
        return;
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
})

app.get("/contract/:method", async (req, res) => {
    try{
        const args = [].concat(req.query.args || []);
        res.json(await callContract("evaluate", req.headers.authorization, req.params.method, args))
    }
    catch(e){
        res.status(400).json({error: e.message})
    }
})

app.post("/contract/:method", async (req, res) => {
    try{
        const args = req.body.args || [];
        res.json(await callContract("submit", req.headers.authorization, req.params.method, args))
    }
    catch(e){
        res.status(400).json({error: e.message})
    }
})

app.listen(8091, () => { console.log("API: http://localhost:8091") })
