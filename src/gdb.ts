import { ChildProcess, spawn } from "child_process";
import { Parser } from "./parse/mi2Parser";
import { Record, IAsyncRecord, AsyncState } from "./parse/outputModel";
import * as fs from 'fs';
import { Breakpoint, BreakpointData, Frame, Thread } from "./gdbModel";
import logger from './log';
import { EventEmitter } from "events";

const GDB_CRCL = `(gdb) \r\n`;

interface GDBOption {
    gdbPath: string;
    args?: string[];
}

class GDB extends EventEmitter {

    private gdbProcess: ChildProcess;
    private token: number = 1;
    private pendingRequest: Map<number, Function> = new Map();
    private breakpoints: Breakpoint[] = new Array();

    constructor(gdbProcess: ChildProcess) {
        super();
        this.gdbProcess = gdbProcess;
        this.gdbProcess.stdout.on('data', this.handleData.bind(this));
    }

    private handleData(data: Buffer) {
        let outputs = data.toString().split(GDB_CRCL);
        outputs.forEach((info) => {
            let record = Parser.parse(info);
            this.handleEvent(record);
            if (record.resultRecord && record.resultRecord.token) {
                let token = Number(record.resultRecord.token);
                if (this.pendingRequest.has(token)) {
                    let callBack = this.pendingRequest.get(token);
                    this.pendingRequest.delete(token);
                    callBack(record);
                }
            }
        })

    }

    private handleEvent(record: Record) {
        if (record.outOfBandRecords) {
            record.outOfBandRecords.forEach(outOfBandRecord => {
                if (!outOfBandRecord.isStream
                    && (outOfBandRecord.record as IAsyncRecord).asyncState === AsyncState.EXEC
                    && (outOfBandRecord.record as IAsyncRecord).asyncOutput.asyncClass === 'stopped') {
                    this.handleStopEvent(outOfBandRecord.record as IAsyncRecord);
                }
            })
        }
    }

    private handleStopEvent(asyncRecord: IAsyncRecord) {
        switch (asyncRecord.asyncOutput.result['reason']) {
            case 'breakpoint-hit':
            case 'watchpoint-trigger':
            case 'read-watchpoint-trigger':
            case 'access-watchpoint-trigger':
            case 'function-finished':
            case 'location-reached':
            case 'watchpoint-scope':
            case 'end-stepping-range':
                this.emit('stop', asyncRecord.asyncOutput.result);
                break;
            case 'exited-signalled':
            case 'exited':
            case 'exited-normally':
            case 'signal-received':
                this.emit('exit', asyncRecord.asyncOutput.result);
                break;
            default:
                break;

        }
    }

    private sendMICommand(command: string): Promise<Record> {

        return new Promise((res, rej) => {
            this.gdbProcess.stdin.write(`${this.token}-${command}\n`, (error) => {
                if (error) {
                    logger.error(`${command}: ${JSON.stringify(error)}`);
                    rej(error);
                }
            });
            let callBack = (recordNode: Record) => {
                if (recordNode.resultRecord.resultClass === 'error') {
                    rej(recordNode.resultRecord.result['msg']);
                } else {
                    res(recordNode);
                }
            }

            this.pendingRequest.set(this.token, callBack);
            let tempToken = this.token;
            setTimeout(() => {
                if (this.pendingRequest.has(tempToken)) {
                    this.pendingRequest.delete(tempToken);
                    rej(`sendCommand: ${command} timeout!!! please reply the command.`);
                }
            }, 1000);

            this.token++;
        });
    }

    private sendCliCommand(command: string) {
        this.gdbProcess.stdin.write(`${command}\n`, (error) => {
            if (error) {
                logger.error(`${command}: ${JSON.stringify(error)}`);
            }
        });
    }

    public exit() {
        if (this.gdbProcess) {
            this.gdbProcess.kill();
            this.gdbProcess = null;
        }
    }

    public openTargetAsync(isOpen?: boolean) {

        let open = !!isOpen ? 'on' : 'off';

        return new Promise((resolve, reject) => {
            this.sendMICommand(`gdb-set target-asyn ${open}`).then((record) => {
                if (record.resultRecord.resultClass === 'done') {
                    resolve(true);
                } else {
                    reject(false);
                }
            }, reject);
        });
    }

    public setApplicationPath(path: string) {
        if (!path) {
            throw 'not parameter path';
        }
        path = path.replace(/\\/g, '\\\\');
        return new Promise((res, rej) => {
            let command = `file-exec-and-symbols \"${path}\"`;
            this.sendMICommand(command).then((record) => {
                if (record.resultRecord.resultClass === 'done') {
                    res(true);
                } else {
                    rej(false);
                }
            }, rej);
        });
    }

    public addBreakpoint(breakPointData: BreakpointData) {
        let command = 'break-insert';
        if (!breakPointData.enabled) {
            command += ' -d';
        }
        if (breakPointData.condition) {
            command += ` -c ${breakPointData.condition}`;
        }
        if (breakPointData.ignore) {
            command += ` -i ${breakPointData.ignore}`;
        }
        if (breakPointData.address) {
            command += ` *${breakPointData.address}`;
        } else if (breakPointData.filePath && breakPointData.lineNum) {
            let filePath = breakPointData.filePath.replace(/\\/g, '\\\\');
            command += ` \"${filePath}:${breakPointData.lineNum}\"`;
        } else {
            return Promise.reject('断点参数设置错误');
        }

        return new Promise((res, rej) => {
            this.sendMICommand(command).then((record) => {
                if (record.resultRecord.resultClass === 'done') {
                    let breakpoint = {
                        num: record.resultRecord.result['bkpt']['number'],
                        type: record.resultRecord.result['bkpt']['type'],
                        disp: record.resultRecord.result['bkpt']['disp'],
                        enabled: record.resultRecord.result['bkpt']['enabled'],
                        addr: record.resultRecord.result['bkpt']['addr'],
                        func: record.resultRecord.result['bkpt']['func'],
                        filename: record.resultRecord.result['bkpt']['file'],
                        fullname: record.resultRecord.result['bkpt']['fullname'],
                        line: record.resultRecord.result['bkpt']['line'],
                        cond: record.resultRecord.result['bkpt']['cond'],
                        ignore: record.resultRecord.result['bkpt']['ignore'],
                        times: record.resultRecord.result['bkpt']['times']
                    }

                    this.breakpoints.push(breakpoint);

                    res(breakpoint);

                } else {
                    rej(null);
                }
            }, rej)
        });
    }

    public run() {
        let command = 'exec-run';
        return new Promise((res, rej) => {
            this.sendMICommand(command).then(record => {
                if (record.resultRecord.resultClass === 'running') {
                    res(true);
                } else {
                    rej(false);
                }
            }, rej);
        });
    }

    public continue() {
        let command = 'exec-continue';
        return new Promise((res, rej) => {
            this.sendMICommand(command).then(record => {
                if (record.resultRecord.resultClass === 'running') {
                    res(true);
                } else {
                    rej(false);
                }
            }, rej);
        });
    }

    public next() {
        let command = 'exec-next';
        return new Promise((res, rej) => {
            this.sendMICommand(command).then(record => {
                if (record.resultRecord.resultClass === 'running') {
                    res(true);
                } else {
                    rej(false);
                }
            }, rej);
        });
    }

    public stepIn() {
        let command = 'exec-step';
        return new Promise((res, rej) => {
            this.sendMICommand(command).then(record => {
                if (record.resultRecord.resultClass === 'running') {
                    res(true);
                } else {
                    rej(false);
                }
            }, rej);
        });
    }

    public stepOut() {
        let command = 'exec-finish';
        return new Promise((res, rej) => {
            this.sendMICommand(command).then(record => {
                if (record.resultRecord.resultClass === 'running') {
                    res(true);
                } else {
                    rej(false);
                }
            }, rej);
        });
    }

    public interrupt() {
        let command = 'exec-interrupt';
        return new Promise((res, rej) => {
            this.sendMICommand(command).then(record => {
                if (record.resultRecord.resultClass === 'done') {
                    res(true);
                } else {
                    rej(false);
                }
            }, rej);
        });
    }

    public getAllStackFrame(): Promise<Frame[]> {
        let command = 'stack-list-frames';
        let stack: Frame[] = [];
        return new Promise((res, rej) => {
            this.sendMICommand(command).then(record => {
                if (record.resultRecord.resultClass === 'done') {
                    stack = record.resultRecord.result['stack'];
                    logger.warn('stack: ', stack);
                    res(stack);
                } else {
                    rej('获取堆栈错误');
                }
            }, rej);
        });
    }

    public removeAllBreakpoints() {
        let all: Promise<boolean>[] = []
        this.breakpoints.forEach(bp => {
            all.push(this.removeBreakpoint(bp.num));
        });
        return Promise.all(all);
    }

    public removeBreakpoint(num: number): Promise<boolean> {
        if (!num) {
            return Promise.reject('要删除的断点的 num 不能为空');
        }
        let command = `break-delete ${num}`;
        return new Promise((res, rej) => {
            this.sendMICommand(command).then((record) => {
                if (record.resultRecord.resultClass === 'done') {
                    this.breakpoints = this.breakpoints.filter((bp) => {
                        return bp.num !== num;
                    })
                    res(true);
                } else {
                    rej(false);
                }
            }, rej)
        })
    }

    public printfAllBreakpoints() {
        logger.info(this.breakpoints);
    }

    public getThreadContext() {
        let command = 'thread-info';
        let threads: Thread[] = [];
        let currentThreadId = null;
        return new Promise((res, rej) => {
            this.sendMICommand(command).then(record => {
                if (record.resultRecord.resultClass === 'done') {
                    threads = record.resultRecord.result['threads'];
                    currentThreadId = record.resultRecord.result['current-thread-id'];
                    logger.warn('threads: ', threads);
                    logger.warn('currentThreadId: ', currentThreadId);
                    let threadContext = {
                        threads,
                        currentThreadId
                    }
                    res(threadContext);
                } else {
                    rej('获取线程错误');
                }
            }, rej);
        });
    }
}

function create(options: GDBOption) {
    let gdbProcess = spawn(options.gdbPath, options.args, {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc']
    });

    gdbProcess.on('exit', (code, signal) => {
        logger.info(`exit: ${code}`);
    });
    gdbProcess.on('error', (error) => {
        logger.info(`error: ${JSON.stringify(error)}`);
    });
    gdbProcess.on('disconnect', () => {
        logger.info('disconnect');
    })

    gdbProcess.on('close', (code, signal) => {
        logger.info(`close: ${code}`);
    });

    return new GDB(gdbProcess);
}

let options = {
    gdbPath: 'D:\\DevTool\\MinGW\\bin\\gdb.exe',
    args: ['--interpreter', 'mi2']
}

let gdb = create(options);

gdb.addListener('stop', (event) => {
    logger.warn('触发监听停止事件', JSON.stringify(event));
    gdb.getAllStackFrame().then((stack) => {
        logger.warn('frame成功');
        logger.warn(stack[0]['addr']);
    }, (error) => {
        logger.warn('frame失败：', JSON.stringify(error));
    });
    gdb.getThreadContext().then((threadContext) => {
        logger.warn('thread成功');
        logger.warn('thread: ', threadContext['threads'][0]);
    }, (error) => {
        logger.warn('frame失败：', JSON.stringify(error));
    });
});

gdb.addListener('exit', (event) => {
    logger.warn('触发监听停止事件', JSON.stringify(event));
    gdb.exit();
})
gdb.openTargetAsync().then((info) => {
    logger.info('设置成功');
    return Promise.resolve();
}, (err) => {
    logger.error('失败：', JSON.stringify(err));
    return Promise.reject();
}).then(() => {
    logger.info('chenggong');
});

gdb.setApplicationPath('C:\\Users\\ming\\Desktop\\testGdb\\main.exe').then((record) => {
    logger.info('设置application成功');
    Promise.resolve();
}, (error) => {
    if (error) {
        logger.error('设置application失败：', JSON.stringify(error));
    }
    Promise.reject();
}).then(() => {
    let breakpointData = {
        filePath: "C:\\Users\\ming\\Desktop\\testGdb\\main.c",
        lineNum: 20,
        condition: "c1",
        enabled: true,
        address: null,
        ignore: null
    }
    return gdb.addBreakpoint(breakpointData);
}).then(() => {
    gdb.printfAllBreakpoints();

    return gdb.run();
}, (error) => {
    logger.error('设置断点失败');
    if (error) {
        logger.info('失败原因：', JSON.stringify(error));
    }
    return Promise.reject();
}).then(() => {
    logger.info('成功启动程序');
});

