import mongoose from 'mongoose';

export async function connectDb(uri: string): Promise<void> {
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
  await mongoose.connection.syncIndexes();
  console.log('[db] terhubung ke MongoDB');
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
}
