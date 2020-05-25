declare module "zerorpc" {
  export class Client {
    constructor();
    connect(url: string): void;
    invoke(method: string, cb: (err: Error | undefined, res: any, more: any) => void) : any;
    invoke(method: string, arg: any, cb: (err: Error | undefined, res: any, more: any) => void) : any;
    invoke(method: string, arg1: any, arg2: any, cb: (err: Error | undefined, res: any, more: any) => void) : any;
    invoke(method: string, arg1: any, arg2: any, arg3: any, cb: (err: Error | undefined, res: any, more: any) => void) : any;
  }
}