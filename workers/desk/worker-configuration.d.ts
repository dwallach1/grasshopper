/* eslint-disable */
interface __BaseEnv_Env {
	DESK_SNAPSHOT: KVNamespace;
	ASSETS: Fetcher;
	DESK_PUBLISH_TOKEN: string;
}
declare namespace Cloudflare {
	interface GlobalProps {
		mainModule: typeof import("./src/index");
	}
	interface Env extends __BaseEnv_Env {}
}
interface Env extends __BaseEnv_Env {}
type StringifyValues<EnvType extends Record<string, unknown>> = {
	[Binding in keyof EnvType]: EnvType[Binding] extends string ? EnvType[Binding] : string;
};
declare namespace NodeJS {
	interface ProcessEnv extends StringifyValues<Pick<Cloudflare.Env, "DESK_PUBLISH_TOKEN">> {}
}
