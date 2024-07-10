// supported actions
let actions = new Map([
    ['request_report',async function([
        type, // expected values: crewai_mm
        client,
        report,
        start_date=null,
        end_date=null,
        prompt=null
    ]) {
        await firebaseAuth();
        let data = {
            type,
            status: "new",
            require_user_response: false,
            user_response: null,
            chat: [],
            client,
            report,
            start_date,
            end_date,
            prompt
        };
        let task = doc(collection(fb_firestore, FIREBASE_TASK_QUEUE));
        await setDoc(task, data);
        console.log('Request scheduled: ', task.id, "\n", data);
    }],
    ['list_queue',async function([type]){
        await firebaseAuth();
        let q = [];
        if (type) q.push(where('type', '==', type));
        let c = await getDocs(query(collection(fb_firestore, FIREBASE_TASK_QUEUE), ...q)) || [];
        c.forEach((doc) => console.log(doc.id, " => ", doc.data()));
    }],
    ['list_pending_reponse',async function([type]){
        await firebaseAuth();
        let q = [where('require_user_response', '==', !0)];
        if (type) q.push(where('type', '==', type));
        let c = await getDocs(query(collection(fb_firestore, FIREBASE_TASK_QUEUE),...q)) || [];
        c.forEach((doc) => console.log(doc.id, " => ", doc.data()));
    }],
    ['submit_user_response_to', async function([id,user_response]){
        await firebaseAuth();
        if (!id || !(user_response||'').length) throw new Error('please provide 2 arguments: task_id and a response string');
        await updateDoc(doc(fb_firestore, `${FIREBASE_TASK_QUEUE}/${id}`),{user_response,require_user_response:!1})
    }],
    ['emit_user_response_request_to',async function([id, content, require_user_response=!0,type=QUEUE_TASK_TYPE.CREWAI_MM_CHAT]){
        if (!messageBus) messageBus=await messageBusInit();
        messageBus.getQueue(type).then(({send})=>send({id, content, require_user_response}));
    }]
]);
//
const QUEUE_TASK_TYPE = {
    SCRAPING: 'web-scraping',
    CLASSIFY: 'classification',
    CREWAI_MM: 'crewai_mm',
    CREWAI_MM_CHAT: 'crewai_mm_chat',
    STORAGE: 'storage'
}
const { initializeApp } = require('firebase/app');
const { getAuth, signInWithEmailAndPassword, onAuthStateChanged,signOut} = require('firebase/auth');
const { getFirestore, collection, onSnapshot, setDoc, updateDoc, arrayUnion, doc, query, where, getDocs } = require('firebase/firestore');
const {
    RABBITMQ_USER,
    RABBITMQ_PASS,
    RABBITMQ_HOST,
    MESSAGE_BUS_TOPIC,
    FIREBASE_USER,
    FIREBASE_PASS,
    FIREBASE_TASK_QUEUE,
    FIREBASE_REPORTS,
    FIREBASE_SETTINGS
} = process.env;
let fb_auth=null;
let fb_user=null;
let fb_firestore=null;
const [,,action,...args] = process.argv;
async function firebaseAuth() {
    if (fb_user) return;
    const fb_app = initializeApp(require('./firebase.config.json'));
    fb_auth = getAuth(fb_app);
    fb_firestore = getFirestore(fb_app);
    onAuthStateChanged(fb_auth, user=>fb_user=user);
    return signInWithEmailAndPassword(fb_auth, FIREBASE_USER, FIREBASE_PASS);
}
function logout() {
    for (let unsubscribe of subscriptions) try {unsubscribe()}catch(e){console.error(e)}
    return signOut(fb_auth).finally(process.exit);
}
// process single request if provided by inline arguments
if (action) return (async ()=>actions.get(action)(args).finally(logout))().catch(e=>console.log("unsupported action:", action, "\n", e));
// else start interactive terminal
firebaseAuth().then(()=>{
    const rl = require('readline').createInterface({
        input: process.stdin,
        output: process.stdout
    });
    rl.on('SIGINT',logout);
    let collect_arguments=async ()=>{
        let option_num=1;
        let args = [];
        while (option_num) await new Promise(r=>{
            rl.question(`\noption#${option_num++}> `, option=>{
                if (!option.length) option_num=0;
                else args.push(option);
                r();
            });
        });
        return args;
    }
    (async ()=>{
        while (!0) await new Promise(r=>{
            rl.question('\nask> ', action=>{
                switch (!0) {
                    case /\s*(exit|logout)\s*/i.test(action): return logout();
                    case !action.replace(/\s*\n*/g,'').length: return r();
                    case [...actions.keys()].includes(action):
                        console.log('Please provide additional options. "Empty line" to finish');
                        collect_arguments().then(args=>actions.get(action)(args)).catch(e=>console.log("Unsupported condition for:", action, "\n", e)).finally(r);
                        break;
                    default:
                        console.log('Supported actions:\n');
                        [...actions.keys()].forEach(key=>console.log(key));
                        r();
                        break;
                }
            })
        });
    })();
}).catch(console.error);
let messageBus=null;
let subscriptions=[];
async function messageBusInit() {
    const amqp = require('amqplib');
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