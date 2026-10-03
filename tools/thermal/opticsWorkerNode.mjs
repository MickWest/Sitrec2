import {parentPort} from "node:worker_threads";
import {buildOpticsMessage} from "./opticsWorker.js";

parentPort.on("message", message => parentPort.postMessage(buildOpticsMessage(message,
    anchor => parentPort.postMessage(anchor))));
