import {
  Request,
  Response,
  ResponseOptions,
  CreateBody,
  HeaderTuple
} from "servie/dist/browser";
import { useRawBody } from "servie/dist/common";

/**
 * Extend response with URL.
 */
export interface XhrResponseOptions extends ResponseOptions {
  url: string;
}

/**
 * XHR responses can indicate a response URL.
 */
export class XhrResponse extends Response implements XhrResponseOptions {
  url: string;

  constructor(body: CreateBody, options: XhrResponseOptions) {
    super(body, options);
    this.url = options.url;
  }
}

/**
 * Valid XHR configuration.
 */
export interface TransportOptions {
  type?: XMLHttpRequestResponseType;
  withCredentials?: boolean;
  overrideMimeType?: string;
}

export class BlockedRequestError extends Error {
  code = "EBLOCKED";

  constructor(public request: Request, message: string) {
    super(message);
  }
}

export class InvalidRequestError extends Error {
  code = "EINVALID";

  constructor(public request: Request, message: string) {
    super(message);
  }
}

export class ConnectionError extends Error {
  code = "EUNAVAILABLE";

  constructor(public request: Request, message: string) {
    super(message);
  }
}

export class CSPError extends Error {
  code = "ECSP";

  constructor(public request: Request, message: string) {
    super(message);
  }
}

export class TypeError extends Error {
  code = "ETYPE";

  constructor(public request: Request, message: string) {
    super(message);
  }
}

export class AbortError extends Error {
  code = "EABORT"

  constructor(public request: Request, message: string) {
    super(message);
  }
}

/**
 * Forward request over `XMLHttpRequest`.
 */
export function transport(options: TransportOptions = {}) {
  return function(req: Request): Promise<XhrResponse> {
    return new Promise<XhrResponse>(function(resolve, reject) {
      const type = options.type || "text";
      const method = req.method.toUpperCase();

      if (req.signal.aborted) {
        return reject(
          new AbortError(req, "Request has been aborted")
        );
      }

      // Loading HTTP resources from HTTPS is restricted and uncatchable.
      if (
        window.location.protocol === "https:" &&
        req.url.startsWith("http:")
      ) {
        return reject(
          new BlockedRequestError(
            req,
            `The connection to "${req.url}" is blocked`
          )
        );
      }

      // Catch URLs that will cause the request to hang indefinitely in CORS
      // disabled environments, such as Atom Editor.
      if (/^https?\:\/*(?:[~#\\\?;\:]|$)/.test(req.url)) {
        return reject(
          new InvalidRequestError(req, `Refusing to connect to "${req.url}"`)
        );
      }

      const xhr = new XMLHttpRequest();
      let hasUploadProgress = false;

      function ondone() {
        const res = new XhrResponse(
          type === "text" ? xhr.responseText : xhr.response,
          {
            status: xhr.status === 1223 ? 204 : xhr.status,
            statusText: xhr.statusText,
            headers: parseXhrHeaders(xhr.getAllResponseHeaders()),
            omitDefaultHeaders: true,
            url: xhr.responseURL
          }
        );

        req.signal.emit("responseStarted");
        req.signal.emit("responseEnded");

        return resolve(res);
      }

      function onerror() {
        return reject(
          new ConnectionError(req, `Unable to connect to "${req.url}"`)
        );
      }

      xhr.onload = ondone;
      xhr.onabort = ondone;
      xhr.onerror = onerror;

      xhr.onprogress = (e: ProgressEvent) => {
        req.signal.emit("requestBytes", e.loaded);
      };

      // No upload will occur with these requests.
      if (method !== "GET" && method !== "HEAD" && xhr.upload) {
        hasUploadProgress = true;

        xhr.upload.onprogress = (e: ProgressEvent) => {
          req.signal.emit("responseBytes", e.loaded);
        };

        xhr.upload.onloadend = () => {
          req.signal.emit("requestEnded");
        };
      }

      // XHR can fail to open when site CSP is set.
      try {
        xhr.open(method, req.url);
      } catch (err) {
        return reject(new CSPError(req, `Refused to connect to "${req.url}"`));
      }

      // Send cookies with CORS.
      if (options.withCredentials) xhr.withCredentials = true;

      // Enable overriding the response MIME handling.
      if (options.overrideMimeType) {
        xhr.overrideMimeType(options.overrideMimeType);
      }

      // Use the passed in type for the response.
      if (type !== "text") {
        try {
          xhr.responseType = type;
        } finally {
          if (xhr.responseType !== type) {
            return reject(new TypeError(req, `Unsupported type: ${type}`));
          }
        }
      }

      for (const [key, value] of req.headers.entries()) {
        if (Array.isArray(value)) {
          for (const v of value) xhr.setRequestHeader(key, v);
        } else {
          xhr.setRequestHeader(key, value);
        }
      }

      req.signal.emit("requestStarted");
      if (!hasUploadProgress) req.signal.emit("requestEnded");

      req.signal.on("abort", () => xhr.abort());

      // Send raw body as-is since it's already best supported.
      xhr.send(useRawBody(req));
    });
  };
}

/**
 * Parse a headers string into an array of raw headers.
 */
function parseXhrHeaders(headers: string): HeaderTuple[] {
  const rawHeaders: HeaderTuple[] = [];
  const lines = headers.split(/\r?\n/);

  for (const line of lines) {
    if (line) {
      const indexOf = line.indexOf(":");
      const name = line.substr(0, indexOf).trim();
      const value = line.substr(indexOf + 1).trim();

      rawHeaders.push([name, value]);
    }
  }

  return rawHeaders;
}
