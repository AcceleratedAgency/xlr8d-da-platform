const amqp = require("amqplib");
const { Server } = require("socket.io");
const http = require("http");
const { MongoClient, ObjectId } = require("mongodb");

const {
  CONFIG_KEY,
  RABBITMQ_USER,
  RABBITMQ_PASS,
  RABBITMQ_HOST,
  MESSAGE_BUS_TOPIC,
  ENABLE_DEBUG,
} = process.env;
let service_config = {};
let messageBus = null;
let mongo_client = null;

const server = http.createServer();
const io = new Server(server, {
  cors: {
    origin: "*",
  },
});
const PROCESS_ID = ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (c) =>
  (
    c ^
    (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))
  ).toString(16)
); //UUIDv4

function log() {
  if (!ENABLE_DEBUG && !service_config.ENABLE_DEBUG) return;
  console.log(...arguments);
}

const subscriptions = [];
function debounce(f, w) {
  let d = setTimeout(f, w);
  return () => {
    clearTimeout(d);
    d = setTimeout(f, w);
  };
}
function endProcess(msg) {
  console.warn(msg);
  for (let unsubscribe of subscriptions)
    try {
      unsubscribe();
    } catch (e) {
      console.error(e);
    }
  console.warn("Exiting in 60sec");
  setTimeout(() => process.exit(), 6e4);
}
let endProcessDelay = debounce(endProcess, 36e5);

function electProcessor(_id) {
  return mongo_client
    .db(service_config.MONGODB_NAME)
    .collection("elections")
    .insertOne({ _id, PROCESS_ID, timestamp: Date.now() })
    .then(() => !0)
    .catch((e) =>
      e.code === 11000 ? log(`Skipping handled task ${_id}`) : console.error(e)
    );
}
// connectivity for message bus
async function messageBusInit() {
  let rabbitmq_conn = null;
  let wait = 200;
  while (!!wait--) {
    //wait for RabbitMQ
    try {
      rabbitmq_conn = await amqp.connect(
        `amqp://${RABBITMQ_USER}:${RABBITMQ_PASS}@${RABBITMQ_HOST}`
      );
      subscriptions.push((_) => rabbitmq_conn.close());
      break;
    } catch (e) {
      log("waiting for RabbitMQ\n", e);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  let queues = new Map();
  if (!rabbitmq_conn) throw new Error("No connection to RabbitMQ found");
  let channel = await rabbitmq_conn.createChannel();
  await channel.assertExchange(MESSAGE_BUS_TOPIC, "topic", { durable: !1 });
  return {
    getQueue: async (queue, prop = { durable: !0 }) => {
      let c = queues.get(queue);
      if (c) return c;
      let channel = await rabbitmq_conn.createChannel();
      await channel.assertQueue(queue, prop);
      c = {
        send: (msg, prop) => {
          log("Sending data to Queue:", queue, "\n", msg);
          return channel.sendToQueue(
            queue,
            Buffer.from(typeof msg != typeof "" ? JSON.stringify(msg) : msg),
            prop
          );
        },
        recv: (fn, prop = { noAck: !1 }) => {
          channel.prefetch(1);
          log("Subscribed to Queue: ", queue);
          return channel.consume(
            queue,
            (msg) => {
              let data = null;
              try {
                data = JSON.parse(msg.content.toString());
              } catch (e) {
                log("Error parsing JSON from: ", data);
              }
              log("Recieved data in Queue:", queue, "\n", data);
              fn(data, channel, msg);
            },
            prop
          );
        },
        channel,
      };
      queues.set(queue, c);
      return c;
    },
    publish: (key, msg) => {
      log(
        "Publishing data to Topic: ",
        MESSAGE_BUS_TOPIC,
        "\n",
        key,
        "\n",
        msg
      );
      return channel.publish(
        MESSAGE_BUS_TOPIC,
        key,
        Buffer.from(typeof msg != typeof "" ? JSON.stringify(msg) : msg)
      );
    },
    subscribe: async (...keys) => {
      let { queue } = await channel.assertQueue("", { exclusive: !0 });
      for (let key of keys) channel.bindQueue(queue, MESSAGE_BUS_TOPIC, key);
      log("Subscribed to the topic:", MESSAGE_BUS_TOPIC, "\n", keys);
      return (fn, prop = { noAck: !0 }) =>
        channel.consume(
          queue,
          (msg) => {
            let data = null;
            try {
              data = JSON.parse(msg.content.toString());
            } catch (e) {
              log("Error parsing JSON from: ", data);
            }
            log(
              "Recieved data in Topic",
              MESSAGE_BUS_TOPIC,
              "\n",
              msg.fields.routingKey,
              "\n",
              data
            );
            fn({ key: msg.fields.routingKey, data }, channel, msg);
          },
          prop
        );
    },
  };
}

// insert config details
async function scheduleNewTask(id, data, collection) {
  if (
    typeof {} !== typeof data ||
    !data.type ||
    data.status != service_config.QUEUE_TASK_STATUS.NEW ||
    !(await electProcessor(id))
  ) {
    await processModifiedTask(id, data, collection).catch(console.error);
    return;
  }

  log("Scheduling new task: ", id, "\n", data);

  messageBus
    .getQueue(data.type)
    .then(({ send }) => send({ ...data, id }))
    .catch(console.error);

  try {
    await collection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { status: service_config.QUEUE_TASK_STATUS.PROCESSING } }
    );
  } catch (error) {
    console.error("Error inserting task into MongoDB:", error);
  }
}
// update the config details
async function processModifiedTask(id, data, collection) {
  if (
    typeof {} !== typeof data ||
    !data.type ||
    data.status != service_config.QUEUE_TASK_STATUS.PROCESSING
  ) {
    return; //TODO: error handling
  }

  switch (!0) {
    case !!data?.user_response && Array.isArray(data?.chat): // handle user response to chat
      if (!(await electProcessor(`${id}-${data.chat?.length}`))) break;
      let msg = { timestamp: Date.now(), content: data.user_response };
      log(
        "sending response from user to: ",
        data.type + ".chat." + id,
        "\n",
        msg
      );
      messageBus.publish(data.type + ".chat." + id, msg);

      try {
        await collection.updateOne(
          { _id: new ObjectId(id) },
          {
            $push: { chat: msg },
            $set: { user_response: null },
          }
        );
      } catch (error) {
        console.error("Error updating task in MongoDB:", error);
      }
      break;
    default:
      break;
  }
}
// used to notifying about process
async function configureMessageBus() {
  //
  await messageBus
    .getQueue(service_config.QUEUE_TASK_TYPE.QUEUE_CHAT)
    .then(({ recv }) =>
      recv(async ({ id, content, require_user_response }, channel, msg) => {
        log("Updating response from Server to chat:", {
          id,
          content,
          require_user_response,
        });
        const taskQueueCollection = mongo_client
          .db(service_config.MONGODB_NAME)
          .collection(service_config.MONGODB_TASK_QUEUE);
        await taskQueueCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $push: { chat: { timestamp: Date.now(), content } },
            ...(require_user_response ? { require_user_response } : {}),
          }
        );
        channel.ack(msg);
      })
    )
    .catch(console.error);
  //
  await messageBus
    .getQueue(service_config.QUEUE_TASK_TYPE.REMOVE_QUEUED)
    .then(({ recv }) =>
      recv(async ({ id }, channel, msg) => {
        log(
          `Removing Queued task "${id}", according to request from MessageBus`
        );
        const taskQueueCollection = mongo_client
          .db(service_config.MONGODB_NAME)
          .collection(service_config.MONGODB_TASK_QUEUE);
        await taskQueueCollection.deleteOne({ _id: new ObjectId(id) });
        channel.ack(msg);
      })
    )
    .catch(console.error);
  //
  await messageBus
    .getQueue(service_config.QUEUE_TASK_TYPE.SCRAPING + ".finished")
    .then(({ recv }) =>
      recv(async ({ id }, channel, msg) => {
        log(`Webscraping task Finished:`, id);

        const db = mongo_client.db(service_config.MONGODB_NAME);
        const taskQueueCollection = db.collection(
          service_config.MONGODB_TASK_QUEUE
        );
        const settingsCollection = db.collection(
          service_config.MONGODB_SETTINGS
        );

        const task = await taskQueueCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!task) {
          channel.ack(msg);
          throw new Error(`Task ${id} not found in queue`);
        }
        await settingsCollection.updateOne(
          {
            slug: task.slug,
            [`${service_config.QUEUE_TASK_TYPE.SCRAPING}.${task.config.id}`]: {
              $exists: true,
            },
          },
          { $set: { last_check: Date.now() } }
        );

        log("Removing Queued task:", id, "\n", task);
        await taskQueueCollection.deleteOne({ _id: new ObjectId(id) });
        channel.ack(msg);
      })
    )
    .catch(console.error);

  await messageBus
    .getQueue(service_config.QUEUE_TASK_TYPE.CREWAI_MM + ".finished")
    .then(({ recv }) =>
      recv(async ({ id, report }, channel, msg) => {
        log(`CrewAI MM task Finished:`, id);
        const db = mongo_client.db(service_config.MONGODB_NAME);
        const taskQueueCollection = db.collection(
          service_config.MONGODB_TASK_QUEUE
        );
        const reportsCollection = db.collection(service_config.MONGODB_REPORTS);
        const task = await taskQueueCollection.findOne({
          _id: new ObjectId(id),
        });
        if (!task) {
          channel.ack(msg);
          throw new Error(`Task ${id} not found in queue`);
        }
        await reportsCollection.insertOne({
          _id: new ObjectId(id),
          slug: task.slug,
          type: service_config.QUEUE_TASK_TYPE.CREWAI_MM,
          report,
          history: task, // TODO: cleanup unnecessary properties
        });
        log("Removing Queued task:", id, "\n", task);
        await taskQueueCollection.deleteOne({ _id: new ObjectId(id) });
        channel.ack(msg);
      })
    )
    .catch(console.error);
}

async function prepareVariables(run, die) {
  await messageBus
    .getQueue(PROCESS_ID, { exclusive: !0 })
    .then(({ recv }) =>
      recv(
        (data, ch, msg) => {
          if (
            PROCESS_ID != msg.properties.correlationId ||
            typeof {} !== typeof data
          )
            throw ch.close();
          Object.assign(service_config, data);
          log("service_config updated", service_config);
          run();
          ch.close();
        },
        { noAck: !0 }
      )
    )
    .catch(die);
  await messageBus
    .getQueue(`${MESSAGE_BUS_TOPIC}.config`)
    .then(({ send }) =>
      send({ CONFIG_KEY }, { replyTo: PROCESS_ID, correlationId: PROCESS_ID })
    )
    .catch(die);
}
// connectivity with socket.io
function initSocketIO(taskQueueCollection) {
  configureMessageBus();
  server.listen(service_config.SOCKET_PORT, () => {
    console.log(
      `Socket.io server running on port ${service_config.SOCKET_PORT}`
    );
  });

  io.on("connection", (socket) => {
    socket.on("task_queue_updated", async () => {
      const tasks = await taskQueueCollection.find().toArray();

      socket.emit("task_queue_updated", tasks);
    });
  });

  const changeStream = taskQueueCollection.watch();

  changeStream.on("change", async (change) => {
    let { operationType, fullDocument, documentKey } = change;

    let id = documentKey._id;
    let type = fullDocument?.type;
    switch (operationType) {
      case "insert":
        await scheduleNewTask(id, fullDocument, taskQueueCollection).catch(
          console.error
        );
        io.emit("task_queue_updated", fullDocument);
        break;
      case "update":
        await processModifiedTask(id, fullDocument).catch(console.error);
        io.emit("task_queue_updated", fullDocument);
        break;
      case "delete":
        if (!(await electProcessor(id + "-cancel"))) break;
        log("Cancelling task: ", id);
        messageBus.publish(
          fullDocument ? fullDocument?.type : type + ".cancel." + id,
          fullDocument
        );
        io.emit("task_queue_updated", { id, deleted: true });
        break;
      default:
        break;
    }
  });

  subscriptions.push(() => changeStream.close());
}
// main function
(async () => {
  messageBus = await messageBusInit();
  log("Connected to messageBus");
  await new Promise(prepareVariables);

  mongo_client = new MongoClient(`${service_config.MONGODB_URI}`);
  let wait = 200;
  while (!!wait--) {
    try {
      await mongo_client.connect();
      subscriptions.push((_) => mongo_client.close());
      break;
    } catch (e) {
      log("waiting for MongoDB\n", e);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  const db = mongo_client.db(service_config.MONGODB_NAME);
  const electionsCollection = db.collection("elections");
  const taskQueueCollection = db.collection(service_config.MONGODB_TASK_QUEUE);

  await electionsCollection.deleteMany({
    timestamp: { $lt: Date.now() - 5 * 60_000 },
  });

  initSocketIO(taskQueueCollection);
})().catch(endProcess);
// --------------------------------------------old code---------------------------------------
// const { initializeApp } = require("firebase/app");
// const {
// getAuth,
// signInWithEmailAndPassword,
// onAuthStateChanged,
// } = require("firebase/auth");
// const {
// getFirestore,
// collection,
// onSnapshot,
// updateDoc,
// arrayUnion,
// doc,
// getDoc,
// deleteDoc,
// setDoc,
// } = require("firebase/firestore");
// const amqp = require("amqplib");
// const { MongoClient } = require("mongodb");
// const {
// CONFIG_KEY,
// RABBITMQ_USER,
// RABBITMQ_PASS,
// RABBITMQ_HOST,
// MESSAGE_BUS_TOPIC,
// ENABLE_DEBUG,
// } = process.env;
// let service_config = {};
// let messageBus = null;
// let mongo_client = null;
// let fb_app = null;
// let fb_auth = null;
// let fb_firestore = null;
// const PROCESS_ID = ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (c) =>
// (
// c ^
// (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))
// ).toString(16)
// ); //UUIDv4

// function log() {
// if (!ENABLE_DEBUG && !service_config.ENABLE_DEBUG) return;
// console.log(...arguments);
// }

// const subscriptions = [];
// function debounce(f, w) {
// let d = setTimeout(f, w);
// return () => {
// clearTimeout(d);
// d = setTimeout(f, w);
// };
// }
// function endProcess(msg) {
// console.warn(msg);
// for (let unsubscribe of subscriptions)
// try {
// unsubscribe();
// } catch (e) {
// console.error(e);
// }
// console.warn("Exiting in 60sec");
// setTimeout(() => process.exit(), 6e4);
// }
// let endProcessDelay = debounce(endProcess, 36e5); //kill if innactive for 60 min

// function electProcessor(_id) {
// return mongo_client
// .db(service_config.MONGODB_NAME)
// .collection("elections")
// .insertOne({ _id, PROCESS_ID, timestamp: Date.now() })
// .then(() => !0)
// .catch((e) =>
// e.code === 11000 ? log(`Skipping handled task ${_id}`) : console.error(e)
// );
// }

// async function messageBusInit() {
// let rabbitmq_conn = null;
// let wait = 200;
// while (!!wait--) {
// //wait for RabbitMQ
// try {
// rabbitmq_conn = await amqp.connect(
// `amqp://${RABBITMQ_USER}:${RABBITMQ_PASS}@${RABBITMQ_HOST}`
// );
// subscriptions.push((_) => rabbitmq_conn.close());
// break;
// } catch (e) {
// log("waiting for RabbitMQ\n", e);
// }
// await new Promise((r) => setTimeout(r, 1000));
// }
// let queues = new Map();
// if (!rabbitmq_conn) throw new Error("No connection to RabbitMQ found");
// let channel = await rabbitmq_conn.createChannel();
// await channel.assertExchange(MESSAGE_BUS_TOPIC, "topic", { durable: !1 });
// return {
// getQueue: async (queue, prop = { durable: !0 }) => {
// let c = queues.get(queue);
// if (c) return c;
// let channel = await rabbitmq_conn.createChannel();
// await channel.assertQueue(queue, prop);
// c = {
// send: (msg, prop) => {
// log("Sending data to Queue:", queue, "\n", msg);
// return channel.sendToQueue(
// queue,
// Buffer.from(typeof msg != typeof "" ? JSON.stringify(msg) : msg),
// prop
// );
// },
// recv: (fn, prop = { noAck: !1 }) => {
// channel.prefetch(1);
// log("Subscribed to Queue: ", queue);
// return channel.consume(
// queue,
// (msg) => {
// let data = null;
// try {
// data = JSON.parse(msg.content.toString());
// } catch (e) {
// log("Error parsing JSON from: ", data);
// }
// log("Recieved data in Queue:", queue, "\n", data);
// fn(data, channel, msg);
// },
// prop
// );
// },
// channel,
// };
// queues.set(queue, c);
// return c;
// },
// publish: (key, msg) => {
// log(
// "Publishing data to Topic: ",
// MESSAGE_BUS_TOPIC,
// "\n",
// key,
// "\n",
// msg
// );
// return channel.publish(
// MESSAGE_BUS_TOPIC,
// key,
// Buffer.from(typeof msg != typeof "" ? JSON.stringify(msg) : msg)
// );
// },
// subscribe: async (...keys) => {
// let { queue } = await channel.assertQueue("", { exclusive: !0 });
// for (let key of keys) channel.bindQueue(queue, MESSAGE_BUS_TOPIC, key);
// log("Subscribed to the topic:", MESSAGE_BUS_TOPIC, "\n", keys);
// return (fn, prop = { noAck: !0 }) =>
// channel.consume(
// queue,
// (msg) => {
// let data = null;
// try {
// data = JSON.parse(msg.content.toString());
// } catch (e) {
// log("Error parsing JSON from: ", data);
// }
// log(
// "Recieveddata in Topic",
// MESSAGE_BUS_TOPIC,
// "\n",
// msg.fields.routingKey,
// "\n",
// data
// );
// fn({ key: msg.fields.routingKey, data }, channel, msg);
// },
// prop
// );
// },
// };
// }

// async function scheduleNewTask(id, data, docRef) {
// if (
// typeof {} !== typeof data ||
// !data.type ||
// data.status != service_config.QUEUE_TASK_STATUS.NEW ||
// !(await electProcessor(id))
// ) {
// await processModifiedTask(id, data, docRef).catch(console.error);
// return;
// } //TODO: error handling
// log("Scheduling new task: ", id, "\n", data);
// messageBus
// .getQueue(data.type)
// .then(({ send }) => send({ ...data, id }))
// .catch(console.error); //TODO: remove unneded fields from data
// updateDoc(docRef, {
// status: service_config.QUEUE_TASK_STATUS.PROCESSING,
// }).catch(console.error);
// }
// async function processModifiedTask(id, data, docRef) {
// if (
// typeof {} !== typeof data ||
// !data.type ||
// data.status != service_config.QUEUE_TASK_STATUS.PROCESSING
// )
// return; //TODO: error handling
// switch (!0) {
// case !!data?.user_response && typeof [] === typeof data?.chat: // handle user response to chat
// if (!(await electProcessor(`${id}-${data.chat?.length}`))) break;
// let msg = { timestamp: Date.now(), content: data.user_response };
// log(
// "sending response from user to: ",
// data.type + ".chat." + id,
// "\n",
// msg
// );
// messageBus.publish(data.type + ".chat." + id, msg);
// updateDoc(docRef, { chat: arrayUnion(msg), user_response: null }).catch(
// console.error
// );
// break;
// default:
// break;
// }
// }
// function initFirestore() {
// fb_app = initializeApp(service_config.FIREBASE_CONFIG);
// fb_auth = getAuth(fb_app);
// fb_firestore = getFirestore(fb_app);
// onAuthStateChanged(fb_auth, async (user) => {
// if (!user) return;
// log("Authenticated to Firebase");
// await configureMessageBus().catch(console.error);
// console.log("\nReady to process tasks.\n");
// let unsubscribe = onSnapshot(
// collection(fb_firestore, service_config.FIREBASE_TASK_QUEUE),
// async (snapshot) => {
// endProcessDelay();
// for (let { type, doc } of snapshot.docChanges()) {
// let id = doc.id;
// let data = doc.data();
// let docRef = doc.ref;
// switch (type) {
// case "added":
// await scheduleNewTask(id, data, docRef).catch(console.error);
// break;
// case "modified":
// await processModifiedTask(id, data, docRef).catch(console.error);
// break;
// case "removed":
// if (!(await electProcessor(id + "-cancel"))) break;
// log("Cancelling task: ", id);
// messageBus.publish(data.type + ".cancel." + id, data);
// break;
// default:
// break;
// }
// }
// },
// endProcess
// );
// subscriptions.push((_) => unsubscribe());
// });
// }
// async function configureMessageBus() {
// //
// await messageBus
// .getQueue(service_config.QUEUE_TASK_TYPE.QUEUE_CHAT)
// .then(({ recv }) =>
// recv(({ id, content, require_user_response }, channel, msg) => {
// log("Updating reponse from Server to chat:", {
// id,
// content,
// require_user_response,
// });
// updateDoc(
// doc(fb_firestore, `${service_config.FIREBASE_TASK_QUEUE}/${id}`),
// {
// chat: arrayUnion({ timestamp: Date.now(), content }),
// ...(require_user_response ? { require_user_response } : {}),
// }
// )
// .then(channel.ack.bind(channel, msg))
// .catch(console.error);
// })
// )
// .catch(console.error);
// //
// await messageBus
// .getQueue(service_config.QUEUE_TASK_TYPE.REMOVE_QUEUED)
// .then(({ recv }) =>
// recv(({ id }, channel, msg) => {
// log(
// `Removing Queued task "${id}", according to request from MessageBus`
// );
// deleteDoc(
// doc(fb_firestore, `${service_config.FIREBASE_TASK_QUEUE}/${id}`)
// )
// .then(channel.ack.bind(channel, msg))
// .catch(console.error);
// })
// )
// .catch(console.error);
// //
// await messageBus
// .getQueue(service_config.QUEUE_TASK_TYPE.SCRAPING + ".finished")
// .then(({ recv }) =>
// recv(({ id }, channel, msg) => {
// log(`Webscraping task Finished:`, id);
// let docRef = doc(
// fb_firestore,
// `${service_config.FIREBASE_TASK_QUEUE}/${id}`
// );
// getDoc(docRef)
// .then((snap) => {
// if (!snap.exists()) {
// channel.ack.bind(channel, msg);
// throw new Error(`Task ${id} not found in queue`);
// }
// let data = snap.data();
// updateDoc(
// doc(
// fb_firestore,
// `${service_config.FIREBASE_SETTINGS}/${data.slug}/${service_config.QUEUE_TASK_TYPE.SCRAPING}/${data.config.id}`
// ),
// { last_check: Date.now() }
// ).catch(console.error);
// log("Removing Queued task:", id, "\n", data);
// return deleteDoc(docRef).then(channel.ack.bind(channel, msg));
// })
// .catch(console.error);
// })
// )
// .catch(console.error);
// //
// await messageBus
// .getQueue(service_config.QUEUE_TASK_TYPE.CREWAI_MM + ".finished")
// .then(({ recv }) =>
// recv(({ id, report }, channel, msg) => {
// log(`CrewAI MM task Finished:`, id);
// let docRef = doc(
// fb_firestore,
// `${service_config.FIREBASE_TASK_QUEUE}/${id}`
// );
// getDoc(docRef)
// .then(async (snap) => {
// if (!snap.exists()) {
// channel.ack.bind(channel, msg);
// throw new Error(`Task ${id} not found in queue`);
// }
// let data = snap.data();
// setDoc(
// doc(
// fb_firestore,
// `${service_config.FIREBASE_REPORTS}/${data.slug}/${service_config.QUEUE_TASK_TYPE.CREWAI_MM}`,
// id
// ),
// {
// report,
// history: data, //TODO: cleanup unnneded properties
// }
// ).catch(console.error);
// log("Removing Queued task:", id, "\n", data);
// return deleteDoc(docRef).then(channel.ack.bind(channel, msg));
// })
// .catch(console.error);
// })
// )
// .catch(console.error);
// //
// }
// async function prepareVariables(run, die) {
// await messageBus
// .getQueue(PROCESS_ID, { exclusive: !0 })
// .then(({ recv }) =>
// recv(
// (data, ch, msg) => {
// if (
// PROCESS_ID != msg.properties.correlationId ||
// typeof {} !== typeof data
// )
// throw ch.close();
// Object.assign(service_config, data);
// log("service_config updated", service_config);
// run();
// ch.close();
// },
// { noAck: !0 }
// )
// )
// .catch(die);
// await messageBus
// .getQueue(`${MESSAGE_BUS_TOPIC}.config`)
// .then(({ send }) =>
// send({ CONFIG_KEY }, { replyTo: PROCESS_ID, correlationId: PROCESS_ID })
// )
// .catch(die);
// }
// (async () => {
// console.log("Starting scheduler: ", PROCESS_ID);
// messageBus = await messageBusInit();
// log("Connected to messageBus");
// await new Promise(prepareVariables);
// mongo_client = new MongoClient(`${service_config.MONGODB_URI}`);
// let wait = 200;
// while (!!wait--) {
// //wait for MongoDB`
// try {
// await mongo_client.connect();
// subscriptions.push((_) => mongo_client.close());
// break;
// } catch (e) {
// log("waiting for MongoDB\n", e);
// }
// await new Promise((r) => setTimeout(r, 1000));
// }
// await mongo_client
//   .db(service_config.MONGODB_NAME)
//   .collection("elections")
//   .deleteMany({ timestamp: { $lt: Date.now() - 5 * 60_000 } }); // cleanup old elections
// initFirestore();
// await signInWithEmailAndPassword(
// fb_auth,
// service_config.FIREBASE_USER,
// service_config.FIREBASE_PASS
// );
// })().catch(endProcess);
