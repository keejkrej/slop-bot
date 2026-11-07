import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Utils } from "electrobun/main";
import type { LocalServer } from "../shared/rpc";

export type DesktopConfig = {
	apiUrl: string;
	token: string;
	deviceId: string;
	servers: LocalServer[];
};

const defaults = (): DesktopConfig => ({
	apiUrl: process.env["SLOP_API_URL"] ?? "http://localhost:3000",
	token: process.env["SLOP_PAIRING_TOKEN"] ?? "",
	deviceId: crypto.randomUUID(),
	servers: [],
});

export class DesktopStore {
	private config?: DesktopConfig;
	private readonly file = join(Utils.paths.userData, "slop-bot-desktop.json");

	async read(): Promise<DesktopConfig> {
		if (this.config) return this.config;
		try {
			this.config = { ...defaults(), ...JSON.parse(await readFile(this.file, "utf8")) } as DesktopConfig;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			this.config = defaults();
			await this.write(this.config);
		}
		return this.config;
	}

	async write(config: DesktopConfig): Promise<void> {
		await mkdir(Utils.paths.userData, { recursive: true });
		const temporary = `${this.file}.${process.pid}.tmp`;
		await writeFile(temporary, JSON.stringify(config, null, 2), { mode: 0o600 });
		await rename(temporary, this.file);
		this.config = config;
	}

	async update(patch: Partial<DesktopConfig>): Promise<DesktopConfig> {
		const next = { ...(await this.read()), ...patch };
		await this.write(next);
		return next;
	}
}
