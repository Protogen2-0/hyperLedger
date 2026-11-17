import Contract from "fabric-contract-api";

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

function createRequest(productName, volume, deliveryDate, technicalRequirements, deliveryRequirements, deliveryAddress, needPrepayment){
    return{
        productName: productName,
        volume: volume,
        deliveryDate: deliveryDate,
        technicalRequirements: technicalRequirements,
        deliveryRequirements: deliveryRequirements,
        deliveryAddress: deliveryAddress,
        needPrepayment: needPrepayment,
        currentState: requestStates[0],
        // производитель может подтверждать заявку
        acceptedByProducer: null,
        // производитель может указать актуальные сведенья
        actualDeliveryDate: null,
        actualDeliveryRequirements: null,
        actualNeedPayment: null,
        // клиент может отказаться от закаказа (случайное создание, предложенные произвоителем параметры не удовлетворяют и тп)
        acceptedByClient: null,
        // оператор может провести ре-кла-ма-ци-онные работы 
        reclamationStartdate: null,
        reclamationEndDate: null,
        reclamationComment: null
    }
}

async function getState(ctx, key){
    return JSON.parse(await ctx.stub.getState(key).toString()); 
}

async function putState(ctx, key, value){
    await ctx.stub.putState(key, Buffer.from(JSON.stringify(value)));
}

// gets org1MSP, org2MSP etc and cuts "MSP" to get only org part : "org1", "org2"
function getMyOrg(ctx){
    return ctx.clientIdentity.getMSPID().replace("MSP", ""); 
}

// returns current user's login in format "org:login", "org1:ivan", "org2:alex" etc
function getMyLogin(ctx){
    return getMyOrg(ctx) + ":" /* + login of current user ? */
}

async function isAdmin(ctx){ // key = "org:name"
    return ( await getState(ctx, getMyLogin(ctx)).role ) === "admin"; 
}

// current user must be from "org" org
function iMustBeFromThisOrg(ctx, org){
    if( getMyOrg(ctx) !== org)
        throw new Error("you must be from org : " + org)
}

// current user must be admin (only possible when user is from org1)
function iMustBeAdmin(ctx){
    if( ! isAdmin(ctx) ) 
        throw new Error("user is not admin")
} 

// checks whether org you're currently in is blocked
function isMyOrgblocked(ctx){
    return blockedOrgs.includes(getMyOrg(ctx))
}

// current user must not be blocked (also counting org block)
async function iMustBeNotBlocked(ctx){
    if( isMyOrgblocked(ctx) )
        throw new Error("org you're currently in is blocked")
    if( await getState(ctx, getMyLogin(ctx).isBlocked) )
        throw new Error("you're blocked")
}

const requestStates = {
    0: "Ожидание подтверждение производителем",
    1: "Ожидание подтверждение клиента",
    2: "Ожидание предоплаты",
    3: "Исполнение",
    4: "Производство продукции",
    5: "Прибытие груза на границу",
    6: "Прохождение таможенной процедуры",
    7: "Доставка груза до заказчика",
    8: "Передача груза покупателю",
    9: "Ожидает оплаты",
    10: "Завершен"
}

let blockedOrgs = [];

class ProductContract extends Contract {
    async InitLedger(ctx){
        await putState(ctx, "org1:ivan", createPerson("admin",    "ivan", [], [], "", "", false)); // org1 = Operator
        await putState(ctx, "org2:igor", createPerson("employee", "igor", [], [], "", "first producer", false)); // org2 = Producer
        await putState(ctx, "org3:petr", createPerson("employee", "petr", [], [], "", "", false)); // org3 = Distributor
        await putState(ctx, "org4:alex", createPerson("employee", "alex", [], [], "", "", false)); // org4 = Client
    }

    async addUser(ctx, org, name, producingRegions, availableRegions, currentRegion, desc){
        iMustBeAdmin(ctx);
        await putState(ctx, org + ":" + name, createPerson("employee", name, producingRegions, availableRegions, currentRegion, desc, false));
    }

    async blockUser(ctx, org, name){
        iMustBeAdmin(ctx);
        const user = await getState(ctx, org + ":" + name);
        if(user.isAdmin)
            throw new Error("cant block admins")
        user.isBlocked = true;
        await putState(ctx, org + ":" + name, user);
    }

    blockOrg(org){
        if( !blockedOrgs.includes(org))
            blockedOrgs.push(org)
    }

    async unblockUser(ctx, org, name){
        iMustBeAdmin(ctx);
        const user = await getState(ctx, org + ":" + name);
        if(user.isAdmin)
            throw new Error("cant unblock admins")
        user.isBlocked = false;
        await putState(ctx, org + ":" + name, user);
    }

    unblockOrg(org){
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
        iMustBeAdmin(ctx);
        const product = await getState(ctx, "product:" + productId);
        if(name) product.name = name;
        if(image) product.image = image;
        if(desc) product.desc = desc;
        if(availableRegions) product.availableRegions = availableRegions;
        product.minVolume = minVolume ?? null;
        product.maxVolume = maxVolume ?? null;
        product.availableDistributors = availableDistributors ?? null;
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
        await putState(ctx, "request:" + ctx.stub.getTxID(), createRequest(productName, volume, deliveryDate, technicalRequirements, deliveryRequirements, deliveryAddress, needPrepayment));
    }
    
}

