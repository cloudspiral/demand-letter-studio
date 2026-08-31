import awsLambdaFastify from "@fastify/aws-lambda";
import { buildApp } from "./server";

const proxyPromise = buildApp().then((app) => awsLambdaFastify(app));

export const handler = async (event: unknown, context: unknown) => {
  const proxy = await proxyPromise;
  return proxy(event, context);
};
