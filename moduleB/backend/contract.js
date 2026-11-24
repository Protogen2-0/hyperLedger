'use strict';
const {Contract} = require("fabric-contract-api")

function createPerson(role, name, producingRegions, availableRegions, currentRegion, desc, isBlocked){
    return {
        role: role,
        name: name,
        producingRegions: producingRegions,
        availableRegions: availableRegions,
        currentRegion: currentRegion,
        desc: desc,
        productList: [],
        isBlocked: isBlocked
    }
}

function createProduct(name, image, desc, availableRegions){
    return{
        name: name,
        image: image,
        desc: desc,
        availableRegions: availableRegions,
        // оператор при подтверждении может указать эти параметры
        acceptedByOperator: null,
        minVolume: null,
        minVolume: null,
        availableDistributors: null
    }
}

function createRequest(productName, volume, deliveryDate, technicalRequirements, deliveryRequirements, deliveryAddress, needPrepayment, client){
    return {
        productName: productName,
        volume: volume,
        deliveryDate: deliveryDate,
        technicalRequirements: technicalRequirements,
        deliveryRequirements: deliveryRequirements,
        deliveryAddress: deliveryAddress,
        needPrepayment: needPrepayment,
        client: client,
        currentState: requestStates[0],
        // производитель может подтверждать заявку
        acceptedByProducer: null,
        // производитель может указать актуальные сведенья
        totalCost: null,
        actualDeliveryDate: null,
        actualDeliveryRequirements: null,
        actualNeedPayment: null,
        // клиент может отказаться от закаказа (случайное создание, предложенные произвоителем параметры не удовлетворяют и тп)
        acceptedByClient: null,
        // этапы поставки, указываются их даты
        productionAt: null,
        productAtTheBorderAt: null,
        customsProcedureAt: null,
        deliveredToCustomerAt: null,
        hangedToClientAt: null,
        // оператор может провести ре-кла-ма-ци-онные работы 
        reclamationStartdate: null,
        reclamationEndDate: null,
        reclamationComment: null
    }
}

async function getState(ctx, key){
    return JSON.parse( (await ctx.stub.getState(key)) .toString() ); 
}

async function putState(ctx, key, value){
    await ctx.stub.putState(key, Buffer.from(JSON.stringify(value)));
}

// gets "org1MSP", "org2MSP" etc and cuts "MSP" to get only org part : "org1", "org2"
function getMyOrg(ctx){
    return ctx.clientIdentity.getMSPID().replace("MSP", ""); 
}

// returns current user's login in format "org:login", "org1:ivan", "org2:alex" etc
function getMyLogin(ctx){
    return getMyOrg(ctx) + ":" + ctx.clientIdentity.getID().match(/CN=\w+/)[0].substring(3);
}

async function isAdmin(ctx){ // key = "org:name"
    return ( (await getState(ctx, getMyLogin(ctx))) .role ) === "admin"; 
}

// current user must be from "org" org
function iMustBeFromThisOrg(ctx, org){
    if( getMyOrg(ctx) !== org)
        throw new Error("you must be from org : " + org)
}

// current user must be admin (only possible when user is from org1)
async function iMustBeAdmin(ctx){
    if( !(await isAdmin(ctx)) ) 
        throw new Error("user is not admin")
} 

// current user must not be blocked (also counting org block)
async function iMustBeNotBlocked(ctx){
    if( blockedOrgs.includes(getMyOrg(ctx)) )
        throw new Error("org you're currently in is blocked")
    if( ( await getState(ctx, getMyLogin(ctx)) ).isBlocked )
        throw new Error("you're blocked")
}

const requestStates = [
    "Ожидание подтверждение производителем",
    "Ожидание подтверждение клиента",
    "Ожидание предоплаты",
    "Исполнение",
    "Ожидает оплаты",
    "Завершен", 
    "Отменен"
]

let blockedOrgs = [];

class ProductContract extends Contract {
    async InitLedger(ctx){
        await putState(ctx, "org1:ivan", createPerson("admin",    "ivan", [], [], "", "", false)); // org1 = Operator
        await putState(ctx, "org2:igor", createPerson("employee", "igor", [], [], "", "first producer", false)); // org2 = Producer
        await putState(ctx, "org3:petr", createPerson("employee", "petr", [], [], "", "", false)); // org3 = Distributor
        await putState(ctx, "org4:alex", createPerson("employee", "alex", [], [], "", "", false)); // org4 = Client
    }

    async addUser(ctx, org, name, producingRegions, availableRegions, currentRegion, desc){
        await iMustBeAdmin(ctx);
        await putState(ctx, org + ":" + name, createPerson("employee", name, producingRegions, availableRegions, currentRegion, desc, false));
    }

    async blockUser(ctx, org, name){
        await iMustBeAdmin(ctx);
        const user = await getState(ctx, org + ":" + name);
        if(user.isAdmin)
            throw new Error("cant block admins")
        user.isBlocked = true;
        await putState(ctx, org + ":" + name, user);
    }

    async blockOrg(ctx, org){
        await iMustBeAdmin(ctx);
        if( !blockedOrgs.includes(org))
            blockedOrgs.push(org)
    }

    async unblockUser(ctx, org, name){
        await iMustBeAdmin(ctx);
        const user = await getState(ctx, org + ":" + name);
        if(user.isAdmin)
            throw new Error("cant unblock admins")
        user.isBlocked = false;
        await putState(ctx, org + ":" + name, user);
    }

    async unblockOrg(ctx, org){
        await iMustBeAdmin(ctx);
        if( blockedOrgs.includes(org))
            blockedOrgs = blockedOrgs.filter( ORG => ORG != org )
    }

    async addProductCard(ctx, name, image, desc, availableRegions){
        iMustBeFromThisOrg(ctx, "org2");
        iMustBeNotBlocked(ctx);
        await putState(ctx, "product:" + ctx.stub.getTxID(), createProduct(name, image, desc, availableRegions));
    }

    // note: "availableDistributors" should be array with "org:login" elements !
    async acceptProduct(ctx, productId, name, image, desc, availableRegions, minVolume, maxVolume, availableDistributors){
        iMustBeFromThisOrg(ctx, "org1");
        iMustBeNotBlocked(ctx);
        const product = await getState(ctx, "product:" + productId);
        if(product.acceptedByOperator)
            throw new Error("already accepted by operator")
        if(name) 
            product.name = name;
        if(image) 
            product.image = image;
        if(desc) 
            product.desc = desc;
        if(availableRegions) 
            product.availableRegions = availableRegions;
        if(minVolume) 
            product.minVolume = minVolume;
        if(maxVolume)
            product.maxVolume = maxVolume;
        if(availableDistributors) 
            product.availableDistributors = availableDistributors;
        product.acceptedByOperator = true;
        await putState(ctx, "product:" + productId, product);
        if(Array.isArray(availableDistributors)) 
            for(i = 0; i < availableDistributors.length; i++){
                const user = await getState(ctx, availableDistributors[i]);
                if( !user.productList.includes(productId) )
                    user.productList.push(productId)
                    await putState(ctx, availableDistributors[i], user)
            }
    }

    async addRequest(ctx, productName, volume, deliveryDate, technicalRequirements, deliveryRequirements, deliveryAddress, needPrepayment){
        iMustBeFromThisOrg(ctx, "org4");
        iMustBeNotBlocked(ctx);
        await putState(ctx, "request:" + ctx.stub.getTxID(), createRequest(productName, volume, deliveryDate, technicalRequirements, deliveryRequirements, deliveryAddress, needPrepayment, getMyLogin(ctx)));
    }

    async acceptRequestByProducer(ctx, requestId, totalCost, actualDeliveryDate, actualDeliveryRequirements, actualNeedPayment){
        iMustBeFromThisOrg(ctx, "org2");
        iMustBeNotBlocked(ctx);
        const request = await getState(ctx, "request:" + requestId);
        if(request.acceptRequestByProducer) 
            throw new Error("already accepter by producer")
        if(totalCost) 
            request.totalCost = totalCost;
        if(actualDeliveryDate) 
            request.actualDeliveryDate = actualDeliveryDate;
        if(actualDeliveryRequirements) 
            request.actualDeliveryRequirements = actualDeliveryRequirements;
        if(actualNeedPayment) 
            request.actualNeedPayment = actualNeedPayment;
        request.acceptRequestByProducer = true;
        request.currentState = requestStates[1];
        await putState(ctx, "request:" + requestId, request);
    }

    async acceptRequestByClient(ctx, requestId){
        iMustBeFromThisOrg(ctx, "org4");
        iMustBeNotBlocked(ctx);
        const request = await getState(ctx, "request:" + requestId);
        if( !request.acceptRequestByProducer )
            throw new Error("request must be accepted by producer")
        if(request.acceptRequestByClient)
            throw new Error("already accepted by client")
        if(request.acceptRequestByClient === false)
            throw new Error("already rejected by client")
        if(request.client != getMyLogin(ctx))
            throw new Error("you're not client that created request")
        request.acceptRequestByClient = true;
        request.currentState = request.needPrepayment ? requestStates[2] : requestStates[3];
        await putState(ctx, "request:" + requestId, request);
    }

    async payPrepayment(ctx, requestId){
        iMustBeFromThisOrg(ctx, "org1");
        iMustBeNotBlocked(ctx);
        const request = await getState(ctx, "request:" + requestId);
        if(requestStates.indexOf(request.currentState) !== 2)
            throw new Error("current state not 2, cant accept prepayment")
        request.currentState = requestStates[3];
    }

    async rejectRequestByClient(ctx, requestId){
        iMustBeFromThisOrg(ctx, "org4");
        iMustBeNotBlocked(ctx);
        const request = await getState(ctx, "request:" + requestId);
        if(request.acceptRequestByClient)
            throw new Error("already accepted by client")
        if(request.acceptRequestByClient === false)
            throw new Error("already rejected by client")
        if(request.client != getMyLogin(ctx))
            throw new Error("you're not client that created request")
        request.acceptRequestByClient = false;
        request.currentState = requestStates[6]
        await putState(ctx, "request:" + requestId, request);
    }

    async incrementRequestStage(ctx, requestId, date){
        iMustBeFromThisOrg(ctx, "org2");
        iMustBeNotBlocked(ctx);
        const request = await getState(ctx, "request:" + requestId);
        if(requestStates.indexOf(request.currentState) !== 3)
            throw new Error("current state not 3, cant progress request stages")
        if(!request.productionAt){
            request.productionAt = date;
        }
        else if(!request.productAtTheBorderAt){
            request.productAtTheBorderAt = date;
        }
        else if(!request.customsProcedureAt){
            request.customsProcedureAt = date;
        }
        else if(!request.deliveredToCustomerAt){
            request.deliveredToCustomerAt = date;
        }
        else if(!request.hangedToClientAt){
            request.hangedToClientAt = date;
        }
        else{
            throw new Error("all stages already completed")
        }
        request.currentState = requestStates[4];
        await putState(ctx, "request:" + requestId, request);
    }

    async acceptRequestByOperator(ctx, requestId){
        iMustBeFromThisOrg(ctx, "org1");
        iMustBeNotBlocked(ctx);
        const request = await getState(ctx, "request:" + requestId);
        if(requestStates.indexOf(request.currentState) !== 4)
            throw new Error("current state not 4, cant accept request")
        request.currentState = requestStates[5];
        await putState(ctx, "request:" + requestId, request);
    }

    async startReclamation(ctx, requestId, startDate){
        iMustBeFromThisOrg(ctx, "org1");
        iMustBeNotBlocked(ctx);
        const request = await getState(ctx, "request:" + requestId);
        if(requestStates.indexOf(request.currentState) !== 4)
            throw new Error("current state not 4, cant start reclamation work")
        request.reclamationStartdate = startDate;
        await putState(ctx, "request:" + requestId, request);
    }

    async endReclamation(ctx, requestId, endDate, comment){
        iMustBeFromThisOrg(ctx, "org1");
        iMustBeNotBlocked(ctx);
        const request = await getState(ctx, "request:" + requestId);
        if(requestStates.indexOf(request.currentState) !== 4)
            throw new Error("current state not 4, cant end reclamation work")
        if(!request.reclamationStartdate)
            throw new Error("reclamation work haven't started")
        request.reclamationEndDate = endDate;
        request.reclamationComment = comment;
        request.currentState = requestStates[5];
        await putState(ctx, "request:" + requestId, request);
    }
    
}

module.exports.contracts = [ProductContract];

