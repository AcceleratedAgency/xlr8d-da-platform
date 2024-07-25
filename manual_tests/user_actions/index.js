// supported actions
let actions = new Map([
    ['request_report',async function([
        slug,
        report,
        client="Test Client Name",
        start_date=null,
        end_date=null,
        prompt=null,
        type=QUEUE_TASK_TYPE.CREWAI_MM
    ]) {
        await firebaseAuth();
        let data = {
            type,
            status: "new",
            created_at: Date.now(),
            require_user_response: false,
            user_response: null,
            chat: [],
            limit_users: [], // limit visibility of task for specific users
            client,
            slug,
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
    ['list_pending_response',async function([type]){
        await firebaseAuth();
        let q = [where('require_user_response', '==', !0)];
        if (type) q.push(where('type', '==', type));
        let c = await getDocs(query(collection(fb_firestore, FIREBASE_TASK_QUEUE),...q)) || [];
        c.forEach((doc) => console.log(doc.id, " => ", doc.data()));
    }],
    ['submit_user_response_to', async function([
        id,
        user_response
    ]){
        await firebaseAuth();
        if (!id || !(user_response||'').length) throw new Error('please provide 2 arguments: task_id and a response string');
        await updateDoc(doc(fb_firestore, `${FIREBASE_TASK_QUEUE}/${id}`),{user_response,require_user_response:!1})
    }],
    ['emit_user_response_request_to',async function([
        id,
        content,
        require_user_response=!0,
        type=QUEUE_TASK_TYPE.QUEUE_CHAT
    ]){
        // can run only within infrastructure
        if (!id || !(user_response||'').length) throw new Error('please provide at least 2 arguments: task_id and a request string');
        if (!messageBus) messageBus=await messageBusInit();
        messageBus.getQueue(type).then(({send})=>send({id, content, require_user_response}));
    }],
    ['emit_classification_task',async function([
        db_doc_id='66a0e0cb5bc6690b99a1fbca',
        db_collection='web_scraping',
        slug='client_2'
    ]){
        // can run only within infrastructure
        if (!messageBus) messageBus=await messageBusInit();
        messageBus.getQueue(type).then(({send})=>send( {
            client: 'Client #2',
            limit_users: [],
            config: {
              name: 'Reviews dumping',
              last_check: 1721819039649,
              id: 'OWAr0tuEgUnatOWMrDnE',
              clickPathAfter: [ 'a[href*="/review/"][name="pagination-button-next"]' ],
              repeat: 2,
              dump: [ '[class*="reviewsContainer"] article[class*="reviewCard"]' ],
              clickPathBefore: [ '(sleep)', '[id*="onetrust-accept"]' ],
              type: 'dump',
              url: 'https://www.trustpilot.com/review/maxbounty.com',
              scraper: 'BrowserStack'
            },
            status: 'new',
            type: 'web_scraping',
            slug,
            id: 'TiKeVA09vrY6qejSc94z',
            db_collection,
            db_doc_id
        }));
    }],
    ['request_web_scraping',async function([
        slug,
        config_id
    ]){
        await firebaseAuth();
        let clientRef = await getDoc(doc(fb_firestore, `${FIREBASE_SETTINGS}/${slug}`));
        if (!clientRef.exists()) throw new Error(`No client found by slug:${slug}`);
        let {client} = clientRef.data();
        let configSnap = await getDoc(doc(fb_firestore, `${FIREBASE_SETTINGS}/${slug}/${QUEUE_TASK_TYPE.SCRAPING}/${config_id}`));
        if (!configSnap.exists()) throw new Error(`No config found by ID:${config_id}`);
        let data = {
            type: QUEUE_TASK_TYPE.SCRAPING,
            status: "new",
            client,
            slug,
            limit_users: [], // limit visibility of task for specific users
            config: {...configSnap.data(), id:config_id}
        };
        let task = doc(collection(fb_firestore, FIREBASE_TASK_QUEUE));
        await setDoc(task, data);
        console.log('web-scraping scheduled: ', task.id, "\n", data);
    }],
    ['add_web_scraping_config',async function([
        slug,
        config_file="./web-scraping-config.json"
    ]){
        let data=JSON.parse(readFileSync(config_file));
        await firebaseAuth();
        let client = await getDoc(doc(fb_firestore, `${FIREBASE_SETTINGS}/${slug}`));
        if (!client.exists()) throw new Error(`No client found by slug:${slug}`);
        let config = doc(collection(fb_firestore, `${FIREBASE_SETTINGS}/${slug}/${QUEUE_TASK_TYPE.SCRAPING}`));
        await setDoc(config, data);
        console.log('web-scraping config added: ', config.id, "\n", data);
    }],
    ['add_client_config',async function([
        client,
        slug=uuidv4()
    ]){
        await firebaseAuth();
        let data = {
            client,
            slug
        }
        let ref = doc(fb_firestore, FIREBASE_SETTINGS, slug);
        await setDoc(ref, data);
        console.log('client config added: ', ref.id, "\n", data);
    }],
    ['list_clients',async function([client]){
        await firebaseAuth();
        let q = [];
        if (client) q.push(where('client', '==', client));
        let c = await getDocs(query(collection(fb_firestore, FIREBASE_SETTINGS), ...q)) || [];
        c.forEach((doc) => console.log(doc.id, " => ", doc.data()));
    }],
    ['list_web_scraping_configs',async function([slug]){
        await firebaseAuth();
        let c = await getDocs(query(collection(fb_firestore, `${FIREBASE_SETTINGS}/${slug}/${QUEUE_TASK_TYPE.SCRAPING}`))) || [];
        c.forEach((doc) => console.log(doc.id, " => ", doc.data()));
    }]
]);
//
function uuidv4() {return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>(c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16))}
const {readFileSync}=require('fs');
const QUEUE_TASK_TYPE = {
    SCRAPING: 'web_scraping',
    CLASSIFY: 'classification',
    CREWAI_MM: 'crewai_mm',
    QUEUE_CHAT: 'queue_chat',
    CDN: 'da_platform_cdn'
}
const { initializeApp } = require('firebase/app');
const { getAuth, signInWithEmailAndPassword, onAuthStateChanged,signOut} = require('firebase/auth');
const { getFirestore, collection, setDoc, updateDoc, doc, query, where, getDocs, getDoc } = require('firebase/firestore');
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
//
let messageBus=null;
let subscriptions=[];
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
                        [...actions.keys()].sort().forEach(key=>console.log(key));
                        r();
                        break;
                }
            })
        });
    })();
}).catch(console.error);
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