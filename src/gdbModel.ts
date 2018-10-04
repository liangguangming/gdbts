export interface Breakpoint {
    num: number;
    type: string;
    disp: string;
    enabled: boolean;  //'y' / 'n'
    addr?: string;    // a watchPoint does not have an address
    func?: string;
    filename?: string;
    fullname?: string;
    line?: number;
    cond?: string;
    ignore?: number;
    times?: number;  // the number of times the breakpoint has been hit
}

export interface BreakpointData {
    filePath: string;
    lineNum: number;
    condition: string;
    enabled: boolean;
    address: string;
    ignore: number;
}

export interface Frame {
    level: string;
    func?: string;
    addr: string;
    file?: string;
    line?: string;
    from?: string;
}

export interface Thread {
    id: string;
    "target-id": string;
    details?: any;
    name?: string;
    state: 'stopped' | 'running';
    frame?: Frame;
    core?: string; 

}