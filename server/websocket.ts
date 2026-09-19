import { Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { parse } from "url";
import { verifyJwt } from "./auth";
import { verifyApiToken } from "./tokens";

interface AuthenticatedWebSocket extends WebSocket {
  userId?: number;
  isAlive?: boolean;
}

interface WebSocketMessage {
  type: 'ping' | 'timer_start' | 'timer_stop' | 'timer_update' | 'notification' | 'dashboard_update';
  data?: any;
  timestamp: string;
}

export class WebSocketManager {
  private wss: WebSocketServer;
  private clients: Map<number, Set<AuthenticatedWebSocket>> = new Map();

  constructor(server: Server) {
    this.wss = new WebSocketServer({ 
      server,
      path: '/ws',
      verifyClient: this.verifyClient.bind(this)
    });

    this.wss.on('connection', this.handleConnection.bind(this));
    this.setupHeartbeat();
  }

  private verifyClient(info: any, cb: (ok: boolean, code?: number, msg?: string) => void): void {
    const url = parse(info.req.url, true);
    const token = url.query.token as string | undefined;
    if (!token) return cb(false, 401, "Unauthorized");
    if (token.startsWith("ptd_")) {
      verifyApiToken(`Bearer ${token}`)
        .then((r) => { if (!r) return cb(false, 401, "Unauthorized"); info.req.userId = r.user.id; cb(true); })
        .catch(() => cb(false, 401, "Unauthorized"));
      return;
    }
    try {
      info.req.userId = verifyJwt(token).id;
      cb(true);
    } catch {
      cb(false, 401, "Unauthorized");
    }
  }

  private handleConnection(ws: AuthenticatedWebSocket, req: any): void {
    ws.userId = req.userId;
    ws.isAlive = true;

    // Add client to user's connection set
    if (!this.clients.has(ws.userId!)) {
      this.clients.set(ws.userId!, new Set());
    }
    this.clients.get(ws.userId!)!.add(ws);

    console.log(`WebSocket client connected for user ${ws.userId}`);

    // Handle ping/pong for connection health
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    // Handle incoming messages
    ws.on('message', (data: Buffer) => {
      try {
        const message: WebSocketMessage = JSON.parse(data.toString());
        this.handleMessage(ws, message);
      } catch (error) {
        console.error('Invalid WebSocket message:', error);
      }
    });

    // Handle disconnection
    ws.on('close', () => {
      console.log(`WebSocket client disconnected for user ${ws.userId}`);
      if (ws.userId && this.clients.has(ws.userId)) {
        this.clients.get(ws.userId)!.delete(ws);
        if (this.clients.get(ws.userId)!.size === 0) {
          this.clients.delete(ws.userId);
        }
      }
    });

    // Send welcome message
    this.sendToClient(ws, {
      type: 'notification',
      data: { message: 'Connected to real-time updates' },
      timestamp: new Date().toISOString()
    });
  }

  private handleMessage(ws: AuthenticatedWebSocket, message: WebSocketMessage): void {
    switch (message.type) {
      case 'ping':
        this.sendToClient(ws, {
          type: 'ping',
          data: { pong: true },
          timestamp: new Date().toISOString()
        });
        break;
      
      default:
        console.log(`Unhandled message type: ${message.type}`);
    }
  }

  private setupHeartbeat(): void {
    setInterval(() => {
      this.wss.clients.forEach((ws: AuthenticatedWebSocket) => {
        if (!ws.isAlive) {
          ws.terminate();
          return;
        }
        ws.isAlive = false;
        ws.ping();
      });
    }, 30000); // 30 seconds
  }

  // Public methods for sending updates
  public sendToUser(userId: number, message: WebSocketMessage): void {
    const userClients = this.clients.get(userId);
    if (userClients) {
      userClients.forEach(client => {
        this.sendToClient(client, message);
      });
    }
  }

  public sendToClient(client: AuthenticatedWebSocket, message: WebSocketMessage): void {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  }

  public broadcastToAll(message: WebSocketMessage): void {
    this.clients.forEach((userClients, userId) => {
      this.sendToUser(userId, message);
    });
  }

  // Timer-specific updates
  public notifyTimerStart(userId: number, timerData: any): void {
    this.sendToUser(userId, {
      type: 'timer_start',
      data: timerData,
      timestamp: new Date().toISOString()
    });
  }

  public notifyTimerStop(userId: number, timerData: any): void {
    this.sendToUser(userId, {
      type: 'timer_stop',
      data: timerData,
      timestamp: new Date().toISOString()
    });
  }

  public notifyTimerUpdate(userId: number, timerData: any): void {
    this.sendToUser(userId, {
      type: 'timer_update',
      data: timerData,
      timestamp: new Date().toISOString()
    });
  }

  // Dashboard updates
  public notifyDashboardUpdate(userId: number, dashboardData: any): void {
    this.sendToUser(userId, {
      type: 'dashboard_update',
      data: dashboardData,
      timestamp: new Date().toISOString()
    });
  }

  // Notifications
  public sendNotification(userId: number, notification: any): void {
    this.sendToUser(userId, {
      type: 'notification',
      data: notification,
      timestamp: new Date().toISOString()
    });
  }

  public getConnectedUsers(): number[] {
    return Array.from(this.clients.keys());
  }

  public getUserConnectionCount(userId: number): number {
    return this.clients.get(userId)?.size || 0;
  }
}

let wsManager: WebSocketManager | null = null;

export function initializeWebSocket(server: Server): WebSocketManager {
  if (!wsManager) {
    wsManager = new WebSocketManager(server);
  }
  return wsManager;
}

export function getWebSocketManager(): WebSocketManager | null {
  return wsManager;
}