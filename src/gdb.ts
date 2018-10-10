import { ChildProcess, spawn } from "child_process";
import { Parser } from "./parse/mi2Parser";
import { Record, IAsyncRecord, AsyncState , IStreamRecord, StreamType} from "./parse/outputModel";
import * as fs from 'fs';
import { Breakpoint, BreakpointData, Frame, Thread, Variable } from "./gdbModel";
import logger from './log';
import { EventEmitter } from "events";
import {Readable} from "stream"

const GDB_CRCL = `(gdb) \r\n`;

interface GDBOption {
    gdbPath: string;
    args?: string[];
}

export class GDB extends EventEmitter {

    private gdbProcess: ChildProcess;
    private token: number = 1;
    private pendingRequest: Map<number, Function> = new Map();
    private breakpoints: Breakpoint[] = new Array();
    private bufferData: string;
    // 文件的所有有效行集合
    private varifyLineMap: Map<string, Array<number>> = new Map();

    constructor(gdbProcess: ChildProcess) {
        super();
        this.gdbProcess = gdbProcess;
        this.bufferData = '';
        this.gdbProcess.stdout.on('data', this.handleData.bind(this));
    }

    private handleData(data: Buffer) {
        this.bufferData += data.toString();
        let outputs = this.bufferData.split(GDB_CRCL);
        let valifyData: string[] = [];
        if (outputs.length > 1) {
            let valifyLength = GDB_CRCL.length * (outputs.length - 1);
            for(let i = 0;i<outputs.length - 1;i++) {
                valifyLength += outputs[i].length;
                valifyData.push(outputs[i]);
            }

            this.bufferData = this.bufferData.substr(valifyLength);
        }
        valifyData.forEach((info) => {
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
                if (outOfBandRecord.isStream) {
                    let streamRecord = (outOfBandRecord.record as IStreamRecord);
                    this.emit('stream', streamRecord);
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

        let temptoken = this.token++;

        return new Promise((res, rej) => {
            try {
                logger.info(`gdbRequest: ${temptoken}-${command}\n`);
                this.gdbProcess.stdin.write(`${temptoken}-${command}\n`, (error) => {
                    if (error) {
                        logger.error(`${command}: ${JSON.stringify(error)}`);
                        rej(error);
                    }
                });
                let callBack = (recordNode: Record) => {
                    if (recordNode.resultRecord.resultClass === 'error') {
    
                        rej(recordNode.resultRecord.result['msg']);
                        logger.info(`gdbResponse error: ${temptoken}-${command}, error ${recordNode.resultRecord.result['msg']}`);
                    } else {
                        res(recordNode);
                        logger.info(`gdbResponse sucessful: ${temptoken}-${command}\n`);
                    }
                }
    
                this.pendingRequest.set(temptoken, callBack);
                setTimeout(() => {
                    if (this.pendingRequest.has(temptoken)) {
                        this.pendingRequest.delete(temptoken);
                        rej(`sendCommand: ${command} timeout!!! please reply the command.`);
                    }
                }, 1000);
            } catch (error) {
                logger.error('sendmicommmand: ', error);
            }

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
            logger.info('gdb进程退出')
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

    public createConsole() {
        let command =  `gdb-set new-console on`;
        return this.sendMICommand(command).then((record) => {
            if (record.resultRecord.resultClass === 'done') {
                return Promise.resolve();
            }
        }, error => {
            return Promise.reject(error);
        })
    }

    public init() {
        return this.openTargetAsync(true).then(() => {
            return this.createConsole();
        }, error => Promise.reject(error));
    }

    public deleteVariable(name: string): Promise<any> {
        if (!name) {
            return Promise.reject('not a varialbe name');
        }
        let command = `var-delete ${name}`;
        this.sendMICommand(command).then((record) => {
            if (record.resultRecord.resultClass === 'done') {
                return Promise.resolve(true);
            } else {
                return Promise.reject(false);
            }
        }, error => Promise.reject(error));
    }

    public clearBreakpointByfilePath(path: string) {
        let toRemove: Promise<boolean>[] = [];
        this.breakpoints.forEach(bp => {
            logger.info('bp.path: ', bp.fullname, 'path: ', path);
            if (bp.fullname.toLocaleLowerCase() === path.toLocaleLowerCase()) {
                toRemove.push(this.removeBreakpoint(bp.num));
            }
        })
        return new Promise((res, rej) => {
            Promise.all(toRemove).then(res,rej);
        })
    }

    public addBreakpoint(breakPointData: BreakpointData): Promise<[boolean, Breakpoint|string]> {

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
            command += ` \"${breakPointData.filePath}:${breakPointData.lineNum}\"`;
            logger.info('command: ', command);
        } else {
            let error = '断点参数设置错误';
            let r: [boolean, string] = [false, error];
            return Promise.resolve(r);
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
                    logger.info('设置断点： ', JSON.stringify(breakpoint));
                    res([true , breakpoint]);

                } else {
                    logger.info('设置断点shibai： ');
                    res([false, null]);
                }
            }, (error) => {
                logger.info('设置断点shibai： ', error);
                res([false, error]);
            })
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

    public continue(threadId: number) {
        let command = `exec-continue --thread ${threadId}`;
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

    public next(threadId: number) {
        let command = `exec-next --thread ${threadId}`;
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

    public stepIn(threadId: number) {
        let command = `exec-step --thread ${threadId}`;
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

    public stepOut(threadId: number) {
        let command = `exec-finish --thread ${threadId}`;
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

    public interrupt(threadId: number) {
        let command = `exec-interrupt --thread ${threadId}`;
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

    public getAllStackFrame(threadId): Promise<Frame[]> {
        if (!threadId) {
            threadId === 1;
        }
        let command = `stack-list-frames --thread ${threadId}`;
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

    public fetchVariable(threadId?: number, frameLevel?: number): Promise<Variable[]> {
        threadId = threadId? threadId: 1;
        frameLevel = frameLevel? frameLevel: 0;
        let command = `stack-list-variables --thread ${threadId} --frame ${frameLevel}  --simple-values`;
        return new Promise((res, rej) => {
            this.sendMICommand(command).then((record) => {
                let variables: Variable[] = [];
                if (record.resultRecord.resultClass === 'done') {
                    let vars: [] = record.resultRecord.result['variables'];
                    let all: Promise<Variable>[] = [];
                    vars.forEach(variable => {
                        all.push(this.createVariable(variable['name']));
                    })
                    Promise.all(all).then((vars) => {
                        variables = vars;
                        res(variables);
                    }, rej)
                } else {
                    rej('获取变量错误');
                }
            }, rej)
        })
    }

    public createVariable(name: string): Promise<Variable> {
        let command = `var-create - * ${name}`;
        return new Promise((res, rej) => {
            this.sendMICommand(command).then((record) => {
                if (record.resultRecord.resultClass === 'done') {
                    let variable: Variable = {
                        objName: record.resultRecord.result['name'],
                        name: name,
                        value: record.resultRecord.result['value'],
                        type: record.resultRecord.result['type'],
                        numchild: record.resultRecord.result['numchild'],
                        'thread-id': record.resultRecord.result['thread-id'],
                        has_more: record.resultRecord.result['has_more']
                    };
                    res(variable);
                } else {
                    rej(`创建 ${name} 对象失败`);
                }
            }, rej)
        });
    }

    public getChildVariables(name: string): Promise<Variable[]> {

        let command = `var-list-children --all-values ${name}`;
        return new Promise((res, rej) => {
            this.sendMICommand(command).then((record) => {
                logger.info('gdb获取自变量成功');
                let childVariables: Variable[] = [];
                if (record.resultRecord.resultClass === 'done') {
                    try {
                        // logger.info('children: ', record.resultRecord.result['children']);
                        if (!record.resultRecord.result['children']) {
                            logger.error('childrenERROR record: ', JSON.stringify(record));
                        }
                        let variables: [] = record.resultRecord.result['children'];
                        variables.forEach(variable => {
                            let childVariable: Variable = {
                                objName: variable['name'],
                                name: variable['exp'],
                                value: variable['value'],
                                type: variable['type'],
                                numchild: variable['numchild'],
                                'thread-id': variable['thread-id'],
                                has_more: variable['has_more']
                            }
    
                            childVariables.push(childVariable);
                        })
                    } catch (error) {
                        logger.error('gdb获取自变量,error: ',error);
                    }
                    res(childVariables)
                } else {
                    logger.error(`获取 ${name} 的变量失败`);
                    rej(`获取 ${name} 的变量失败`);
                }
            }, rej)
        });
    }

    public setVariable(name: string, expression: any) {

        let command = `var-assign ${name} ${expression}`;
        return this.sendMICommand(command)
        .then((record) =>{
            if (record.resultRecord.resultClass === 'done') {
                // let updateVariableCommand = `var-update ${name}`;
                // return this.sendMICommand(updateVariableCommand)
                let value = record.resultRecord.result['value'];
                return Promise.resolve(value);
            } else {
                return Promise.reject('更改变量名失败');
            }
        }, error => {
            return Promise.reject(error);
        })
    }

    public updateVariable(name: string) {
        let command = `var-update ${name}`;
        return this.sendMICommand(command).then((record) => {
            if (record.resultRecord.resultClass === 'done') {
                return Promise.resolve();
            } else {
               return Promise.reject('更新所有变量失败');
            }
        }, error => {
           return Promise.reject(error);
        })
    }

    public evaluate(expression: string) {
        let command = `var-evaluate-expression ${expression}`;
        return this.sendMICommand(command).then((record) => {
            if (record.resultRecord.resultClass === 'done') {
                let value = record.resultRecord.result['value'];
                return Promise.resolve(value);
            } else {
                return Promise.reject('获取变量失败');
            }
        },error => {
            return Promise.reject(error);
        })
    }

    public selectFrame(frame: number) {
        let command = `stack-select-frame ${frame}`;
        this.sendMICommand(command).then((record) => {
            if (record.resultRecord.resultClass === 'done') {
                return Promise.resolve(true);
            } else {
                return Promise.reject('选择selectFrame失败');
            }
        }, error => Promise.reject(error));
    }

    public selectThread(threadId: number) {
        let command = `thread-select ${threadId}`;
        return this.sendMICommand(command).then((record) => {
            if (record.resultRecord.resultClass === 'done') {
                return Promise.resolve(true);
            } else {
                return Promise.reject('选择thread失败');
            }
        }, error => Promise.reject(error));
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

    public verifyLine(path: string) {
            if (this.varifyLineMap.has(path)) {
                return Promise.resolve(true);
            }

            //  -symbol-list-lines main.c  也能得到有效行验证，这个指令更加专注
            let command = `symbol-list-lines ${path}`;
            return this.sendMICommand(command).then((record) => {
                if (record.resultRecord.resultClass === 'done') {
                    // 处理数据
                    let lines: [] = record.resultRecord.result['lines'];
                    lines.forEach(element => {
                        if (this.varifyLineMap.has(path)) {
                            let arrayLine = this.varifyLineMap.get(path);
                            arrayLine.push(Number(element['line']));
                            arrayLine = Array.from(new Set(arrayLine));
                        } else {
                            this.varifyLineMap.set(path, []);
                            this.varifyLineMap.get(path).push(Number(element['line']));
                        }
                    });
                    return Promise.resolve(true);
                }
            },rej => {
                logger.info(`path: ${path} 命令执行失败，${rej}`);
                return Promise.reject(rej);
            })
    }

    public getVarifyLine(path: string, line: number) {
        if (!this.varifyLineMap.has(path)) {
            throw '还没有校验该路径';
        }

        return this.varifyLineMap.get(path).indexOf(line) >= 0;
    }
}

export function create(options: GDBOption) {
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


