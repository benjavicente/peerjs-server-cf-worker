import { DurableObject } from 'cloudflare:workers';

const WELCOME_TEXT =
	'{"name":"PeerJS Server","description":"A server side element to broker connections between PeerJS clients.","website":"https://peerjs.com/"}';
const HEARTBEAT = '{"type":"HEARTBEAT"}';
const OPEN = '{"type":"OPEN"}';
const ID_TAKEN = '{"type":"ID-TAKEN","payload":{"msg":"ID is taken"}}';

export class PeerServerDO extends DurableObject {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(HEARTBEAT, HEARTBEAT));
	}

	public async getNextId() {
		const lenght = 6;
		const id = (await this.ctx.storage.get<number>('id')) ?? 0;

		const decoded = new TextEncoder().encode(id.toString());
		const hash = await crypto.subtle.digest('SHA-256', decoded).then((buffer) =>
			Array.from(new Uint8Array(buffer))
				.map((b) => b.toString(16).padStart(2, '0'))
				.join('')
				.slice(0, lenght)
		);

		await this.ctx.storage.put('id', id + 1);
		return hash;
	}

	async fetch(request: Request) {
		const url = new URL(request.url);
		const id = url.searchParams.get('id');
		const token = url.searchParams.get('token');
		if (!id || !token) return new Response(null, { status: 400 });
		const [wsclient, wsserver] = Object.values(new WebSocketPair());

		const existingWss = this.ctx.getWebSockets(id);
		if (existingWss.length > 0 && existingWss[0].deserializeAttachment().token !== token) {
			wsserver.accept();
			wsserver.send(ID_TAKEN);
			wsserver.close(1008, 'ID is taken');
			return new Response(null, { webSocket: wsclient, status: 101 });
		} else {
			existingWss.forEach((ws) => ws.close(1000));
		}

		this.ctx.acceptWebSocket(wsserver, [id]);
		wsserver.serializeAttachment({ id, token });
		wsserver.send(OPEN);

		return new Response(null, { webSocket: wsclient, status: 101 });
	}
	webSocketMessage(ws: WebSocket, message: string): void | Promise<void> {
		const msg = JSON.parse(message);
		const dstWs = this.ctx.getWebSockets(msg.dst)[0];
		msg.src = ws.deserializeAttachment().id;
		dstWs.send(JSON.stringify(msg));
	}
}

export default {
	async fetch(request: Request, env: Env) {
		const url = new URL(request.url);

		switch (url.pathname) {
			case '/':
				return new Response(WELCOME_TEXT);
			case '/peerjs': {
				const stub = env.PEER_SERVER.getByName(url.host);
				return stub.fetch(request);
			}
			case '/peerjs/id': {
				const stub = env.PEER_SERVER.getByName(url.host);
				const id = await stub.getNextId();
				return new Response(id, {
					status: 200,
					headers: {
						'Content-Type': 'text/plain',
						'Access-Control-Allow-Origin': '*',
					},
				});
			}
			default:
				return new Response(null, { status: 404 });
		}
	},
};
