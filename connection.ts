import { sendCommand } from "./protocol/mod.ts";
import type { RedisReply, RedisValue } from "./protocol/mod.ts";
import type { Backoff } from "./backoff.ts";
import { exponentialBackoff } from "./backoff.ts";
import { ErrorReplyError, isRetriableError } from "./errors.ts";
import { BufReader } from "./vendor/https/deno.land/std/io/buf_reader.ts";
import { BufWriter } from "./vendor/https/deno.land/std/io/buf_writer.ts";
import { delay } from "./vendor/https/deno.land/std/async/delay.ts";
type Closer = Deno.Closer;

export interface Connection {
  closer: Closer;
  reader: BufReader;
  writer: BufWriter;
  maxRetryCount: number;
  isClosed: boolean;
  isConnected: boolean;
  isRetriable: boolean;
  close(): void;
  connect(): Promise<void>;
  reconnect(): Promise<void>;
  sendCommand(command: string, args?: Array<RedisValue>): Promise<RedisReply>;
}

export interface RedisConnectionOptions {
  tlsOptions?: Partial<Deno.ConnectTlsOptions>;
  tls?: boolean;
  db?: number;
  password?: string;
  username?: string;
  name?: string;
  /**
   * @default 10
   */
  maxRetryCount?: number;
  backoff?: Backoff;
}

const kEmptyRedisArgs: Array<RedisValue> = [];

export class RedisConnection implements Connection {
  name: string | null = null;
  closer!: Closer;
  reader!: BufReader;
  writer!: BufWriter;
  maxRetryCount = 10;

  private readonly hostname: string;
  private readonly port: number | string;
  private _isClosed = false;
  private _isConnected = false;
  private backoff: Backoff;

  get isClosed(): boolean {
    return this._isClosed;
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  get isRetriable(): boolean {
    return this.maxRetryCount > 0;
  }

  constructor(
    hostname: string,
    port: number | string,
    private options: RedisConnectionOptions
  ) {
    this.hostname = hostname;
    this.port = port;
    if (options.name) {
      this.name = options.name;
    }
    if (options.maxRetryCount != null) {
      this.maxRetryCount = options.maxRetryCount;
    }
    this.backoff = options.backoff ?? exponentialBackoff();
  }

  private async authenticate(
    username: string | undefined,
    password: string
  ): Promise<void> {
    try {
      password && username
        ? await this.sendCommand("AUTH", [username, password])
        : await this.sendCommand("AUTH", [password]);
    } catch (error) {
      if (error instanceof ErrorReplyError) {
        throw new AuthenticationError("Authentication failed", {
          cause: error,
        });
      } else {
        throw error;
      }
    }
  }

  private async selectDb(
    db: number | undefined = this.options.db
  ): Promise<void> {
    if (!db) throw new Error("The database index is undefined.");
    await this.sendCommand("SELECT", [db]);
  }

  async sendCommand(
    command: string,
    args?: Array<RedisValue>
  ): Promise<RedisReply> {
    try {
      const reply = await sendCommand(
        this.writer,
        this.reader,
        command,
        args ?? kEmptyRedisArgs
      );
      return reply;
    } catch (error) {
      if (!isRetriableError(error) || this.isManuallyClosedByUser()) {
        throw error;
      }

      for (let i = 0; i < this.maxRetryCount; i++) {
        // Try to reconnect to the server and retry the command
        this.close();
        try {
          await this.connect();

          const reply = await sendCommand(
            this.writer,
            this.reader,
            command,
            args ?? kEmptyRedisArgs
          );

          return reply;
        } catch {
          // TODO: use `AggregateError`?
          const backoff = this.backoff(i);
          await delay(backoff);
        }
      }

      throw error;
    }
  }

  /**
   * Connect to Redis server
   */
  async connect(): Promise<void> {
    await this.#connect(0);
  }

  async #connect(retryCount: number) {
    try {
      const dialOpts = {
        ...(this.options.tlsOptions || {}),
        hostname: this.hostname,
        port: parsePortLike(this.port),
      };

      const conn: Deno.Conn = this.options?.tls
        ? await Deno.connectTls(dialOpts)
        : await Deno.connect(dialOpts);

      this.closer = conn;
      this.reader = new BufReader(conn);
      this.writer = new BufWriter(conn);
      this._isClosed = false;
      this._isConnected = true;

      try {
        if (this.options.password != null) {
          await this.authenticate(this.options.username, this.options.password);
        }
        if (this.options.db) {
          await this.selectDb(this.options.db);
        }
      } catch (error) {
        this.close();
        throw error;
      }
    } catch (error) {
      if (error instanceof AuthenticationError) {
        throw error.cause ?? error;
      }

      const backoff = this.backoff(retryCount);
      retryCount++;
      if (retryCount >= this.maxRetryCount) {
        throw error;
      }
      await delay(backoff);
      await this.#connect(retryCount);
    }
  }

  close() {
    this._isClosed = true;
    this._isConnected = false;
    try {
      this.closer!.close();
    } catch (error) {
      if (!(error instanceof Deno.errors.BadResource)) throw error;
    }
  }

  async reconnect(): Promise<void> {
    if (!this.reader.peek(1)) {
      throw new Error("Client is closed.");
    }
    try {
      await this.sendCommand("PING");
      this._isConnected = true;
    } catch (_error) {
      // TODO: Maybe we should log this error.
      this.close();
      await this.connect();
      await this.sendCommand("PING");
    }
  }

  private isManuallyClosedByUser(): boolean {
    return this._isClosed && !this._isConnected;
  }
}

class AuthenticationError extends Error {}

function parsePortLike(port: string | number | undefined): number {
  let parsedPort: number;
  if (typeof port === "string") {
    parsedPort = parseInt(port);
  } else if (typeof port === "number") {
    parsedPort = port;
  } else {
    parsedPort = 6379;
  }
  if (!Number.isSafeInteger(parsedPort)) {
    throw new Error("Port is invalid");
  }
  return parsedPort;
}
