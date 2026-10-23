import { z } from "zod";
import { body, client, failure, json } from "@/server/http";
export async function POST(request: Request) {
  try {
    await body(request, z.object({}).strict());
    return json(await client().session());
  } catch (error) {
    return failure(error);
  }
}
