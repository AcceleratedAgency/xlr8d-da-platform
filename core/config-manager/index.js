const amqp = require('amqplib');
const {readFileSync}=require('fs')
const {
    ENVIRONMENT,
    RABBITMQ_USER,
    RABBITMQ_PASS,
    RABBITMQ_HOST,
    MESSAGE_BUS_TOPIC,
    ENABLE_DEBUG
} = process.env;

function log() {
    if (!ENABLE_DEBUG) return;
    console.log(...arguments);
}
const subscriptions = [];
function endProcess(msg) { 
    console.warn(msg);
    for (let unsubscribe of subscriptions) try {unsubscribe()}catch(e){console.error(e)}
    console.warn('Exiting in 60sec');
    setTimeout(()=>process.exit(),6e4);
}
const QUEUE_TASK_TYPE = {
    SCRAPING: 'web_scraping',
    CLASSIFY: 'classification',
    CREWAI_MM: 'crewai_mm',
    QUEUE_CHAT: 'queue_chat',
    CDN: 'da_platform_cdn',
    REMOVE_QUEUED: 'da_platform_remove_queued'
}
const QUEUE_TASK_STATUS = {
    NEW: 'new',
    PROCESSING: 'processing',
    DONE: 'done'
}
const service_configs=new Map(JSON.parse(readFileSync(`./service.config.${ENVIRONMENT}.json`)));
async function getConfig({CONFIG_KEY}) {return {...service_configs.get(CONFIG_KEY), QUEUE_TASK_STATUS, QUEUE_TASK_TYPE, ENVIRONMENT, ENABLE_DEBUG}}

(async function() {
    let rabbitmq_conn=null;
    let wait = 200;
    while (!!wait--) {//wait for RabbitMQ
        try {
            rabbitmq_conn = await amqp.connect(`amqp://${RABBITMQ_USER}:${RABBITMQ_PASS}@${RABBITMQ_HOST}`);
            subscriptions.push(_=>rabbitmq_conn.close());
            break;
        } catch(e) { log('waiting for RabbitMQ\n', e)}
        await new Promise(r=>setTimeout(r,1000));
    }
    if (!rabbitmq_conn) throw new Error('No connection to RabbitMQ found');
    let channel = await rabbitmq_conn.createChannel();
    await channel.assertQueue(`${MESSAGE_BUS_TOPIC}.config`, {durable: !0});
    channel.prefetch(1);
    log('Ready to process config requests');
    await channel.consume(`${MESSAGE_BUS_TOPIC}.config`,msg=>{
        let request=null;
        let queue=null;
        let correlationId=null;
        try {
            request=JSON.parse(msg.content.toString());
            queue=msg.properties.replyTo;
            correlationId=msg.properties.correlationId;
            if (!request || !queue || !correlationId) throw new Error({queue,correlationId,request});
        } catch (e) {
            channel.ack(msg);
            return console.error('Inconsistent request:\n', msg.content.toString(), '\n', e);
        }
        log('Recieved request in Queue:', `${MESSAGE_BUS_TOPIC}.config`, '\n', request);
        getConfig(request)
        .then(response=>channel.sendToQueue(queue,Buffer.from((typeof response != typeof '')? JSON.stringify(response):response), {correlationId}))
        .catch(e=>console.log('Error getting config for request:\n',request,'\n',e))
        .finally(()=>channel.ack(msg));
    },{noAck:!1});
})().catch(endProcess);
