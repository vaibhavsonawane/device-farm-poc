import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectEnv } from '../config/config.module';
import { type Env } from '../config/env';

const AUDIENCE = 'devicelab-stream';

export interface ViewerTicket {
  typ: 'stream-ticket';
  sid: string;
  sub: string;
  role: 'controller' | 'observer';
}

export interface AgentStreamToken {
  typ: 'agent-stream';
  sid: string;
  hid: string;
}

/** Tokens for the binary stream sockets, signed with a key separate from access tokens. */
@Injectable()
export class StreamTokens {
  constructor(
    private readonly jwt: JwtService,
    @InjectEnv() private readonly env: Env,
  ) {}

  private sign(payload: ViewerTicket | AgentStreamToken, expiresIn: number): Promise<string> {
    return this.jwt.signAsync(payload, {
      secret: this.env.JWT_STREAM_SECRET,
      audience: AUDIENCE,
      issuer: 'devicelab',
      expiresIn,
    });
  }

  private async verify<T extends ViewerTicket | AgentStreamToken>(
    token: string | null,
    typ: T['typ'],
  ): Promise<T | null> {
    if (!token) return null;
    try {
      const p = await this.jwt.verifyAsync<T>(token, {
        secret: this.env.JWT_STREAM_SECRET,
        audience: AUDIENCE,
        issuer: 'devicelab',
        algorithms: ['HS256'],
      });
      return p.typ === typ ? p : null;
    } catch {
      return null;
    }
  }

  /** One-minute ticket the browser presents when opening the stream socket. */
  viewerTicket(sessionId: string, userId: string, role: ViewerTicket['role']): Promise<string> {
    return this.sign({ typ: 'stream-ticket', sid: sessionId, sub: userId, role }, 60);
  }

  verifyViewerTicket(token: string | null): Promise<ViewerTicket | null> {
    return this.verify<ViewerTicket>(token, 'stream-ticket');
  }

  /** Long enough for agent reconnects within a session; the session must still be open on connect. */
  agentToken(sessionId: string, hostId: string): Promise<string> {
    return this.sign({ typ: 'agent-stream', sid: sessionId, hid: hostId }, 12 * 3600);
  }

  verifyAgentToken(token: string | null): Promise<AgentStreamToken | null> {
    return this.verify<AgentStreamToken>(token, 'agent-stream');
  }
}
