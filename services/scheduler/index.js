const { initializeApp } = require('firebase/app');
const { getAuth, signInWithEmailAndPassword, onAuthStateChanged } = require('firebase/auth');
const { getFirestore, collection, onSnapshot, updateDoc, arrayUnion, doc, getDoc } = require('firebase/firestore');
const amqp = require('amqplib');
const { MongoClient } = require('mongodb');
const {
    MONGODB_USER,
    MONGODB_PASS,
    MONGODB_HOST,
    MONGODB_NAME,
    RABBITMQ_USER,
    RABBITMQ_PASS,
    RABBITMQ_HOST,
    FIREBASE_USER,
    FIREBASE_PASS,
    FIREBASE_TASK_QUEUE,
    FIREBASE_REPORTS,
    FIREBASE_SETTINGS,
    MESSAGE_BUS_TOPIC
} = process.env;
function debounce(f,w) {
    let d=setTimeout(f,w);
    return ()=>{clearTimeout(d);d=setTimeout(f,w);}
}
const subscriptions = [];
function endProcess(msg) { 
    console.warn(msg);
    for (let unsubscribe of subscriptions) try {unsubscribe()}catch(e){console.error(e)}
    console.warn('Exiting in 60sec');
    setTimeout(()=>process.exit(),6e4);
}
let endProcessDelay = debounce(endProcess,36e5);//kill if innactive for 60 min
let messageBus = null;
const mongo_client = new MongoClient(`mongodb://${MONGODB_USER}:${MONGODB_PASS}@${MONGODB_HOST}`);
const PROCESS_ID = ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>(c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)); //UUIDv4
const QUEUE_TASK_TYPE = {
    SCRAPING: 'web-scraping',
    CLASSIFY: 'classification',
    CREWAI_MM: 'crewai_mm',
    CREWAI_MM_CHAT: 'crewai_mm_chat',
    CDN: 'da_platform_cdn',
    REMOVE_QUEUED: 'da_platform_remove_queued'
}
const QUEUE_TASK_STATUS = {
    NEW: 'new',
    PROCESSING: 'processing',
    DONE: 'done'
}

function electProcessor(_id) {
    return mongo_client.db(MONGODB_NAME).collection('elections').insertOne({_id,PROCESS_ID,timestamp:Date.now()})
    .then(()=>!0)
    .catch(e=>e.code===11000?console.log(`Skipping handled task ${_id}`):console.error(e));
}


async function messageBusInit() {
    let rabbitmq_conn=null;
    let wait = 200;
    while (!!wait--) {//wait for RabbitMQ
        try {
            rabbitmq_conn = await amqp.connect(`amqp://${RABBITMQ_USER}:${RABBITMQ_PASS}@${RABBITMQ_HOST}`);
            subscriptions.push(rabbitmq_conn.close.bind(rabbitmq_conn));
            break;
        } catch(e) { console.log('waiting for RabbitMQ\n', e)}
        await new Promise(r=>setTimeout(r,1000));
    }
    let queues = new Map();
    if (!rabbitmq_conn) throw new Error('No connection to RabbitMQ found');
    let channel = await rabbitmq_conn.createChannel();
    await channel.assertExchange(MESSAGE_BUS_TOPIC, 'topic', {durable: !1});
    return {
        getQueue: async queue => {
            let c = queues.get(queue);
            if (c) return c;
            let channel = await rabbitmq_conn.createChannel();
            await channel.assertQueue(queue, {durable: !0});
            c = {
                send: (msg,prop)=>channel.sendToQueue(queue,Buffer.from((typeof msg != typeof '')? JSON.stringify(msg):msg),prop),
                recv: (fn,prop={noAck:!1}) => {
                    channel.prefetch(1);
                    return channel.consume(queue,msg=>{
                        let data=null;
                        try {data=JSON.parse(msg.content.toString())} catch (e) {console.log('Error parsing JSON from: ', data)}
                        fn(data,channel,msg);
                    },prop);
                },
                channel
            };
            queues.set(queue,c);
            return c;
        }, 
        publish: (key,msg)=>channel.publish(MESSAGE_BUS_TOPIC, key, Buffer.from((typeof msg != typeof '')? JSON.stringify(msg):msg)),
        subscribe: async (...keys)=>{
            let {queue} = await channel.assertQueue('',{exclusive: !0});
            for (let key of keys) channel.bindQueue(queue,MESSAGE_BUS_TOPIC,key);
            return (fn,prop={noAck:!0}) => channel.consume(queue,msg=>{
                let data=null;
                try {data=JSON.parse(msg.content.toString())} catch (e) {console.log('Error parsing JSON from: ', data)}
                fn({key:msg.fields.routingKey,data},channel,msg);
            },prop);
        }
    }
}

async function scheduleNewTask(id,data,docRef){
    if (typeof {} !== typeof data || !data.type || data.status != QUEUE_TASK_STATUS.NEW || !await electProcessor(id)) {
        await processModifiedTask(id, data, docRef).catch(console.error);
        return;
    } //TODO: error handling
    messageBus.getQueue(data.type).then(({send})=>send({...data,id})).catch(console.error);//TODO: remove unneded fields from data
    updateDoc(docRef, {status: QUEUE_TASK_STATUS.PROCESSING}).catch(console.error);
}
async function processModifiedTask(id, data, docRef) {
    if (typeof {} !== typeof data || !data.type || data.status != QUEUE_TASK_STATUS.PROCESSING) return; //TODO: error handling
    switch (!0) {
        case (data.type === QUEUE_TASK_TYPE.CREWAI_MM && !!data?.user_response && (typeof [] === typeof data?.chat)): // handle user response to chat 
            if (!await electProcessor(`${id}-${data.chat?.length}`)) break;
            let msg = {timestamp: Date.now(), content: data.user_response};
            messageBus.publish(data.type+".chat."+id, msg);
            updateDoc(docRef, {chat: arrayUnion(msg), user_response: null}).catch(console.error);
            break;
        default: break;
    }
}
const fb_app = initializeApp(require('./firebase.config.json'));
const fb_auth = getAuth(fb_app);
const fb_firestore = getFirestore(fb_app);
onAuthStateChanged(fb_auth, async user => {
    if (!user) return;
    await configureMessageBus().catch(console.error);
    console.log('\nReady to process tasks.\n');
    subscriptions.push(onSnapshot(collection(fb_firestore, FIREBASE_TASK_QUEUE), async snapshot => {
        endProcessDelay();
        for (let {type, doc} of snapshot.docChanges()) {
            let id = doc.id;
            let data = doc.data();
            let docRef = doc.ref;
            switch (type) {
                case 'added':
                    await scheduleNewTask(id, data, docRef).catch(console.error);
                    break;
                case 'modified':
                    await processModifiedTask(id, data, docRef).catch(console.error);
                    break;
                case 'removed':
                    if (!await electProcessor(id+"-cancel")) break;
                    messageBus.publish(data.type+".cancel", {id});
                    break;
                default: break;
            }
        }
    },endProcess));
});
async function configureMessageBus() {
    messageBus = await messageBusInit();
    // pre-configure queues
    // for (let type of Object.values(QUEUE_TASK_TYPE)) await messageBus.getQueue(type).catch(console.error);
    // listeners
    await messageBus.getQueue(QUEUE_TASK_TYPE.CREWAI_MM_CHAT).then(({recv})=>recv(({id,content,require_user_response},channel,msg)=>{
        updateDoc(doc(fb_firestore, `${FIREBASE_TASK_QUEUE}/${id}`),{chat: arrayUnion({timestamp: Date.now(),content}),...(require_user_response?{require_user_response}:{})})
        .then(channel.ack.bind(channel,msg))
        .catch(console.error);
    })).catch(console.error);
    await messageBus.getQueue(QUEUE_TASK_TYPE.REMOVE_QUEUED).then(({recv})=>recv(({id},channel,msg)=>{
        deleteDoc(doc(fb_firestore,`${FIREBASE_TASK_QUEUE}/${id}`))
        .then(channel.ack.bind(channel,msg))
        .catch(console.error);
    })).catch(console.error);
    await messageBus.getQueue(QUEUE_TASK_TYPE.SCRAPING+".finished").then(({recv})=>recv(({id},channel,msg)=>{
        console.log(id);
        let docRef=doc(fb_firestore,`${FIREBASE_TASK_QUEUE}/${id}`);
        getDoc(docRef).then(snap=>{
            if (!snap.exists()) throw new Error(`Task ${id} not found in queue`);
            let data=snap.data();
            console.log(data);
            updateDoc(doc(fb_firestore,`${FIREBASE_SETTINGS}/${data.slug}/${QUEUE_TASK_TYPE.SCRAPING}/${data.config.id}`), {last_check: Date.now()}).catch(console.error);
            return deleteDoc(docRef).then(channel.ack.bind(channel,msg))
        }).catch(console.error); 
    })).catch(console.error);
}
(async ()=>{
    console.log('Starting scheduler: ', PROCESS_ID);
    let wait = 200;
    while (!!wait--) {//wait for MongoDB
        try {
            await mongo_client.connect();
            subscriptions.push(mongo_client.close.bind(mongo_client));
            break;
        } catch(e) { console.log('waiting for MongoDB\n', e)}
        await new Promise(r=>setTimeout(r,1000));
    }
    await mongo_client.db(MONGODB_NAME).collection('elections').deleteMany({ timestamp: { $lt: Date.now() - (5 * 60_000)}}); // cleanup old elections
    await signInWithEmailAndPassword(fb_auth, FIREBASE_USER, FIREBASE_PASS);
})().catch(endProcess);