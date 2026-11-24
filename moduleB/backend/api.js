import cors from "cors";
import express from "express";
import grpc from "@grpc/grpc-js";
import fabric from "@hyperledger/fabric-gateway";
import childProcess from "child_process";
import path from "path";
import crypto from "crypto";
import fs from "fs";

const FABRIC_SAMPLES_PATH = path.resolve(__dirname, "../../fabric-samples");
const ORGANIZATIONS_PATH = FABRIC_SAMPLES_PATH + "test-network/organizations";

const ORGS = {
    org1: { msp: "org1MSP"  , peer: "localhost:7054"  ,    caPort: 7051    }, // операторы
    org2: { msp: "org2MSP"  , peer: "localhost:9054"  ,    caPort: 8051    }, // производители
    org3: { msp: "org3MSP"  , peer: "localhost:11051" , /* caPort: 9051  */}, // дистрибуторы
    org4: { msp: "org4MSP"/*, peer: "localhost:13054" ,    caPort: 10051 */}  // клиенты
}

const sessions = new Map();

function runCommand(org, args, errorMessage){
    const env = Object.assign({}, process.env, {
        FABRIC_CA_CLIENT_HOME: ORGANIZATIONS_PATH + "/peerOrganizations/" + org + ".example.com"
    });
    const commandArgs = ["--caname", "ca-" + org, "--tls.certfiles", ORGANIZATIONS_PATH + "/fabric-ca/" + org + "/ca-cert.pem"];
    try{
        childProcess.execFileSync(FABRIC_SAMPLES_PATH + "/bim/fabric-ca-client", args.concat(commandArgs), {env:env});
    }
    catch(e){
        throw new Error(errorMessage)
    }
}

function register(org, name, password){
    runCommand(org,
        ["register", "--id.name", name, "--id.secret", password, "--id.type", "client", /* "--id.affiliation", org + ".department1", */ "--id.attrs"],
        "не удалось зарегестрироваться"
    )
}

function login(org, name, password){
    const url = "https://" + encodeURIComponent(name) + ":" + encodeURIComponent(password) + "@localhost:" + ORGS[org].caPort;
    const USERMSP_PATH = ORGANIZATIONS_PATH + "/peerOrganizations/" + org  + ".example.com/users/" + name + "@" + org + ".example.com/msp"
    runCommand(
        org,
        ["enroll", "-u", url, "-M", USERMSP_PATH],
        "неверное имя, пароль, или организация"
    )
    const keyFile = fs.readFileSync(USERMSP_PATH + "/keystore")[0];
    const token = crypto.randomUUID();
    sessions.set( 
        token,
        {
            org: org,
            certificate: fs.readFileSync(USERMSP_PATH + "/signcerts/cert.pem"),
            privateKey: crypto.createPrivateKey(fs.readFileSync(USERMSP_PATH + "/keystore/" + keyFile))
        }
    );
    return token;
}

const clients = {};
function grpcClient(org){
    const tlsCert = fs.readFileSync(ORGANIZATIONS_PATH + "/peerOrganizations/" + org + ".example.com/tlsca/tlsca." + org + ".example.com-cert.pem");
    if(!clients[org] || !clients[org].tlsCert.equals(tlsCert)){
        if(clients[org]) 
            clients[org].client.close()
        clients[org] = {
            tlsCert: tlsCert,
            client: new grpcClient.Client(ORGS[org].peer, grpc.credintals.createSsl(tlsCert), {
                "grpc.ssl_target_name_override": "peer0." + org + ".example.com"
            })
        };
    }
    return clients[org].client;
}

async function callContract(type, token, method, args){
    const user = sessions.get(token);
    if(!user)
        throw new Error("требуется вход")
    const gateway = fabric.connect({
        client: grpcClient(user.org),
        identity: { mspId: ORGS[user.org].msp, credentials: user.certificate},
        signer: fabric.signers.newPrivateKeySigner(user.privateKey),
        hash: fabric.hash.sha256
    })
    try{
        const contract = gateway.getNetwork("mychannel").getContract("basic");
        const result = type === "submit" ? 
            await contract.submit  (method, {arguments: args}) :
            await contract.evaluate(method, {arguments: args})
        return JSON.parse(Buffer.from(result).toString());
    }
    catch(e){
        throw e;
    }
    finally{
        gateway.close();
    }
}


const app = express();

app.use(cors());
app.use(express.json());

app.post("/register", async (req, res) => {
    try{
        register(req.body.org, req.body.role, req.body.name, req.body.password);
        const token = login(req.body.org, req.body.name, req.body.password);
        await callContract("submit", token, /* "functionName" */ "", [/* func args */] )
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
