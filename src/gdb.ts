import { ChildProcess, spawn } from "child_process";
import { Parser } from "./parse/mi2Parser";
import { Record, IAsyncRecord, AsyncState } from "./parse/outputModel";
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
        let command = `var-create ${name} * ${name}`;
        return new Promise((res, rej) => {
            this.sendMICommand(command).then((record) => {
                if (record.resultRecord.resultClass === 'done') {
                    let variable: Variable = {
                        name: record.resultRecord.result['name'],
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
                                parentName: variable['name'],
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
            let command = `data-disassemble -f ${path} -l 1 -- 1`;
            return this.sendMICommand(command).then((record) => {
                if (record.resultRecord.resultClass === 'done') {
                    // 处理数据
                    let asm_insns: [] = record.resultRecord.result['asm_insns'];
                    asm_insns.forEach(element => {
                        // 有效行判断
                        let line_asm_insn: [] = element['line_asm_insn'];
                        if (line_asm_insn.length > 0) {
                            if (this.varifyLineMap.has(path)) {
                                this.varifyLineMap.get(path).push(Number(element['line']));
                            } else {
                                this.varifyLineMap.set(path, []);
                                this.varifyLineMap.get(path).push(Number(element['line']));
                            }
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


