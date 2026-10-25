// Müştərilər və istifadə sayğacı üçün MongoDB bağlantısı (AI_MONGODB_URI verilibsə).
// Elanların oxunduğu "own-site" bazasından (MONGODB_URI) ayrıdır: onlara toxunmur.
import mongoose from "mongoose";

let injected; // testlər üçün
let connecting;

export const mongoEnabled = () => Boolean(injected || process.env.AI_MONGODB_URI);
export const useStoreDb = (db) => { injected = db; };

export async function storeDb() {
  if (injected) return injected;
  connecting ??= new mongoose.mongo.MongoClient(process.env.AI_MONGODB_URI, { serverSelectionTimeoutMS: 8000 }).connect();
  try {
    return (await connecting).db(process.env.AI_MONGODB_DB || "car_advisor_ai");
  } catch (e) {
    connecting = undefined; // növbəti çağırışda yenidən cəhd
    throw e;
  }
}
