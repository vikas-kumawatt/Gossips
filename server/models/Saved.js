import { Schema, model } from "mongoose";

const SavedSchema = new Schema({
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    post: { type: Schema.Types.ObjectId, ref: "Post", required: true },
    createdAt: { type: Date, default: Date.now },
  });
  
  export default model("Saved", SavedSchema);
  