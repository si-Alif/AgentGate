import {Queue} from "bullmq";
import {redis} from "../lib/redis.js";

export interface EmailQueueJob{
  type : "verification"
  email: string
  token : string
}

export const emailQueue = new Queue<EmailQueueJob>("email", {
  connection: redis,
});