import express from "express";
import { findUser } from "../db/users";

export const router = express.Router();

router.get("/users/:id", async (req, res) => {
  res.json(await findUser(req.params.id));
});
