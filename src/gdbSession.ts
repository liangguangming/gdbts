import {	
    DebugSession,
	LoggingDebugSession,
	InitializedEvent, TerminatedEvent, StoppedEvent, ContinuedEvent, OutputEvent, ThreadEvent, BreakpointEvent, ModuleEvent, LoadedSourceEvent, CapabilitiesEvent,
	Thread, StackFrame, Scope, Variable,
	Breakpoint, Source, Module, CompletionItem,
	ErrorDestination,
	Event, Response,
    Handles } from 'vscode-debugadapter'
import { DebugProtocol } from 'vscode-debugprotocol';
import logger from './log';
import { create, GDB } from './gdb';
import * as gdbModel from './gdbModel';
import { Record, IAsyncRecord, AsyncState , IStreamRecord, StreamType} from "./parse/outputModel";

const LOCALREFERENCE = 100;
const variableReferenceRegexp = /^(\d\d\d)(\d\d)(\d\d)(\d+)/

// variableReference = 10001023  // 局部变量(100) 线程: 01 frame: 02 变量: 3

// 错误： 11： 变量抓取失败
/**
 *  100: 启动程序失败
 *  12: 设置断点失败
 *  13: 抓取变量失败
 *  14: 继续执行失败
 *  15: 下一步执行失败
 * 	16: 跳入执行失败
 *  17： 跳出执行失败
 *  18: getScope fail
 *  19: 校验断点失败
 *  20: 设置变量失败
 *  21: 评估变量值
 *  24: 初始化失败
 */
    
class GDBSession extends DebugSession {

	private gdb: GDB;
	private requestNum = 1;
	private variableMap: Map<number,string> = new Map();

	// key为threadId,value 为线程底下所有rootVariableName;
	private rootVariablesNameMap: Map<number,string[]>= new Map();
	private childVariableId = 1;

	constructor() {
		super();
	}

	private registerListener() {
		if (this.gdb) {
			this.gdb.addListener('stop', (event) => {
				let stopEvent = new StoppedEvent(event['reason'], Number(event['thread-id']));
				stopEvent.body['allThreadsStopped'] = event['stopped-threads'] === 'all';

				logger.info('触发断点停止，thread: ', JSON.stringify(stopEvent));
				this.sendEvent(stopEvent);
			});
			this.gdb.addListener('exit', (event) => {
				let exitEvent = new TerminatedEvent(false);
				this.sendEvent(exitEvent);
			});
			this.gdb.addListener('stream', (streamRecord) => {
				switch((streamRecord as IStreamRecord).streamType) {
					case StreamType.CONSOLE: 
						streamRecord.cString = streamRecord.cString.replace(/\\n/g,'\r\n').replace(/\\"/g,"\"");
						let consoleEvent =  new OutputEvent(streamRecord.cString, 'console');
						this.sendEvent(consoleEvent);
						break;
					case StreamType.LOG:
						let logEvent =  new OutputEvent(streamRecord.cString, 'stdout');
						this.sendEvent(logEvent);
						break;
					case StreamType.TARGET:
						let targetEvent =  new OutputEvent(streamRecord.cString, 'telemetry');
						this.sendEvent(targetEvent);
						break;
					default:
						break;
				}
			})
		}
	}

	private removeAllListener() {
		this.gdb.removeAllListeners();
	}

	private parseVariableReference(variableReference: number) {
		let refMatch = variableReferenceRegexp.exec(variableReference.toString());
		let scope = Number(refMatch[1]);
		let thread = Number(refMatch[2]);
		let frameLevel = Number(refMatch[3]);
		let variable = Number(refMatch[4]);
		let tuple: [number, number, number, number] = [scope,thread,frameLevel,variable];
		return tuple;
	}

	private convertVariableReference(scope: number,thread: number, frameLevel: number, variable: number) {
		let threadStr = (thread>9)? thread.toString(): '0' + thread;
		let frameLevelStr = (frameLevel>9)? frameLevel.toString(): '0' + frameLevel;
		return Number(scope.toString() + threadStr + frameLevelStr + variable.toString());
	}

	private getVariableReference(name: string) {
		let variableReference = 0;
		this.variableMap.forEach((value,key) => {
			logger.info('value: ',value, 'key: ',key);
			if (value === name) {
				variableReference = key;
			}
		});

		return variableReference;
	}

	private getVariableName(variableReference: number) {
		if (this.variableMap.has(variableReference)) {
			return this.variableMap.get(variableReference);
		} else {
			return '';
		}
	}

	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
		logger.info('初始化请求成功');
		response.body.supportsConfigurationDoneRequest = true;
		response.body.supportsConditionalBreakpoints = true;
		response.body.supportsHitConditionalBreakpoints = true;
		response.body.supportsSetVariable = true;
		this.sendResponse(response);
	}

    public launchRequest(response: DebugProtocol.LaunchResponse, args: DebugProtocol.LaunchRequestArguments): void {
		logger.info('args',JSON.stringify(args));
		let gdbpath = args['gdbpath'];
		let target = args['target'];

		let options = {
			gdbPath: gdbpath,
			args: ['--interpreter', 'mi2']
		}

		this.gdb = create(options);
		this.registerListener();
		this.gdb.setApplicationPath(target)
		.then(() => {
			this.gdb.init()
			.then(() => {
				this.sendEvent(new InitializedEvent());
			}, error => this.sendErrorResponse(response,24,error))
		}, error => this.sendErrorResponse(response,24,error));
		this.once('start', () => {
			logger.info('激活启动程序');
			this.gdb.run().then(() => {
				logger.info('启动程序');
				this.sendResponse(response);
			}, (error) => {
				logger.info('启动程序失败');
				this.sendErrorResponse(response, 100 , error );
			});
		});
	}

	protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {
		let breakpointPath = args.source.path;
		breakpointPath = breakpointPath.replace(/\\/g, '\\\\');
		logger.info('breakpointPath: ', breakpointPath);
		let breakPointDatas: gdbModel.BreakpointData[] = [];
		args.breakpoints.forEach(bp => {
			let breakpoint: gdbModel.BreakpointData = {
				lineNum: bp.line,
				filePath: breakpointPath,
				condition: bp.condition? bp.condition.replace(/\s/g, ''): null,
				ignore: bp.hitCondition? Number(bp.hitCondition) - 1: null,
				enabled: true,
				address: null
			}
			breakPointDatas.push(breakpoint);
		})
		// 完成校验断点有效行
		this.gdb.verifyLine(breakpointPath).then(() => {
			// 清理以前的断点
			this.gdb.clearBreakpointByfilePath(breakpointPath).then(()=> {
				// 新增断点
				let all: Promise<[boolean , string|gdbModel.Breakpoint]>[] = [];
				breakPointDatas.forEach(bp => {
					if (this.gdb.getVarifyLine(bp.filePath,bp.lineNum)) {
						all.push(this.gdb.addBreakpoint(bp));
					} else {
						let r: [boolean, string|gdbModel.Breakpoint] = [false,null];
						all.push(Promise.resolve(r))
					}
				})

				// 如果有一个为false,都会被拒绝
				Promise.all(all).then((bps) => {
					let breakpoints: Breakpoint[] = [];
					bps.forEach(tup => {
						logger.info('tup: ', JSON.stringify(tup))
						let breakpoint: Breakpoint = null;
						if (tup[0]) {
							let line = (tup[1] as gdbModel.Breakpoint).line;
							// let source: Source = new Source()
							breakpoint = new Breakpoint(true, line);
						} else {
							breakpoint = new Breakpoint(false);
						}
						breakpoints.push(breakpoint);
					})
					response.body = {
						breakpoints: breakpoints
					}
					this.sendResponse(response);
					logger.info('设置断点成功');
				})
			},(error) => {
				this.sendErrorResponse(response,12,error);
			})
		}, error => {
			this.sendErrorResponse(response, 19,`${error}`);
		})
	}

	protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
		logger.info('配置完成请求完成')
		this.sendResponse(response);
		this.emit('start');
	}

	// 抓取堆栈信息
	protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {
		let threadId = args.threadId;
		let start = args.startFrame;
		let levels = args.levels;
		logger.info('stackTraceRequest','args: ',JSON.stringify(args));
		this.gdb.getAllStackFrame(threadId).then((frames) => {
			let stackFrames: DebugProtocol.StackFrame[] = [];
			frames.forEach(frame => {
				let source: DebugProtocol.Source;
				if (frame.line && frame.fullname) {
					source = {
						name: frame.file,
						path: frame.fullname
					}
					source.path = source.path.replace(/\\\\/g, '\\');
					logger.info('source.path: ', source.path);
				}
				let thread = (threadId>9)? threadId.toString(): ('0' + threadId);
				let level = (Number(frame.level)>9)? frame.level: ('0' + frame.level);
				let stackFrame: DebugProtocol.StackFrame = {
					line: frame.line? Number(frame.line):null,
					name: frame.func,
					id: Number(LOCALREFERENCE.toString() + thread + level + '0'),
					column: 0,
					source: source
				}
				stackFrames.push(stackFrame);
			});
			logger.info('stack: ', JSON.stringify(stackFrames));
			response.body = {
				stackFrames: stackFrames
			}
			logger.info('stackresponse: ', JSON.stringify(response));
			this.sendResponse(response);
		},(err) => {
			this.sendErrorResponse(response,13,err);
		})
	}

	// 抓取所有线程
	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
		logger.info('threadRequest sucessful');
		this.gdb.getThreadContext().then((threadContext) => {
			let threads: DebugProtocol.Thread[] = [];
			logger.info('threads: ', JSON.stringify(threadContext['threads']));
			try {
				threadContext['threads'].forEach(thread => {
					let t: DebugProtocol.Thread = {
						id: Number(thread['id']),
						name: thread['name']?thread['name']: `thread${thread['id']}`
					}
					threads.push(t);
				});
				threads = threads.sort((a,b) => {
					return a.id - b.id;
				})
			response.body = {
				threads: threads
			}
			this.sendResponse(response);
			logger.info('threadResponse sucessful, threads: ', JSON.stringify(threads));
		} catch (error) {
			logger.error(JSON.stringify(error));
		}
		})
	}

	// 抓取变量范围
	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {
		let frameId = args.frameId;
		let scopeLocal,thread,frameLevel,variableNum;
		// 解析frameId
		[scopeLocal,thread,frameLevel,variableNum] = this.parseVariableReference(frameId);
		// 先清理数据再响应
		let all: Promise<any>[] = [];
		if (this.rootVariablesNameMap.has(thread)) {
			this.rootVariablesNameMap.get(thread).forEach((name) => {
				all.push(this.gdb.deleteVariable(name));
			})
		}
		Promise.all(all).then(()=> {
			if (this.rootVariablesNameMap.has(thread)) {
				this.rootVariablesNameMap.set(thread, []);
			}
			let scope: DebugProtocol.Scope = {
				name: 'Locals',
				variablesReference: frameId,
				expensive: false
			}
			response.body = {
				scopes: [scope]
			}
			this.sendResponse(response);
			logger.info('scopes 响应成功')
		}, (error) => {
			this.sendErrorResponse(response, 18, error);
		});
	}

	// 抓取变量
	protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): void {
		logger.info('variablesRequest args: ', JSON.stringify(args));
		let variablesReference = args.variablesReference;
		let scope,thread,frameLevel,variableNum;
		[scope,thread,frameLevel,variableNum] = this.parseVariableReference(variablesReference);
		let variables: Variable[] = [];
		if (scope === LOCALREFERENCE && variableNum === 0) {
			this.gdb.fetchVariable(thread, frameLevel).then((vars) => {
				vars.forEach(v => {
					let variable: Variable = null;
					if (this.rootVariablesNameMap.has(thread)) {
						this.rootVariablesNameMap.get(thread).push(v.objName);
					} else {
						this.rootVariablesNameMap.set(thread, []);
						this.rootVariablesNameMap.get(thread).push(v.objName);
					}
					
					if (Number(v.numchild)>0) {
						let ref = this.convertVariableReference(LOCALREFERENCE,thread,frameLevel,this.childVariableId++);
						variable = new Variable(v.name,v.value,	ref);
						this.variableMap.set(ref, v.objName);
					} else {
						variable = new Variable(v.name, v.value);
					}

					variables.push(variable);
				});

				response.body = {
					variables: variables
				}
				this.sendResponse(response);
			}, (error) => {
				this.sendErrorResponse(response,12,error);
			})
		} else if(scope === LOCALREFERENCE && variableNum > 0) {
			let name = this.getVariableName(variablesReference);
			// this.gdb.updateVariable()
			this.gdb.getChildVariables(name).then((vars)=>{
				try {
					vars.forEach(v => {
						let variable: Variable = null;
						if (Number(v.numchild)>0) {
							let ref = this.convertVariableReference(LOCALREFERENCE,thread,frameLevel,this.childVariableId++);
							variable = new Variable(v.name,v.value,	ref);
							this.variableMap.set(ref, v.objName);
						} else {
							variable = new Variable(v.name, v.value);
						}
	
						variables.push(variable);
					})
				} catch (error) {
					logger.error(JSON.stringify(error));
				}

				response.body = {
					variables: variables
				}
				this.sendResponse(response);
			},(error) => {
				logger.error(`获取变量error: ${error}`)
				this.sendErrorResponse(response,11,error);
			})
		} else {
			logger.error(`获取变量error`);
			this.sendErrorResponse(response,11,'没有抓取到相关数据');
		}
	}

	// 设置变量
	protected setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments): void {
		let name = this.getVariableName(args.variablesReference)?(this.getVariableName(args.variablesReference) + '.' + args.name): args.name;
		let value = args.value;
		this.gdb.setVariable(name,value).then((value) => {
			response.body = {
				value: value
			}
			this.sendResponse(response);
		}, error => {
			this.sendErrorResponse(response, 20, error);
		})
	}

	// watch断点
	protected setExpressionRequest(response: DebugProtocol.SetExpressionResponse, args: DebugProtocol.SetExpressionArguments): void {
		let expression = args.expression;
		let value = args.value;
		logger.info('setExpressionRequest args: ',JSON.stringify(args));
		return this.sendResponse(response);
	}

	protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): void {
		let expression = args.expression;
		let scope,thread,frameLevel,variableNum;
		[scope,thread,frameLevel,variableNum] = this.parseVariableReference(args.frameId);
		this.gdb.selectThread(thread)
		.then(()=>{
			return this.gdb.selectFrame(frameLevel);
		}, error => this.sendErrorResponse(response,23,error))
		.then(()=> {
			this.gdb.createVariable(expression).then((variable) => {
				let ref;
				if (Number(variable.numchild)>0) {
					ref = this.convertVariableReference(LOCALREFERENCE,thread,frameLevel,this.childVariableId++);
					this.variableMap.set(ref, variable.objName);
				} else {
					ref = 0;
				}
				response.body = {
					result: variable.value,
					variablesReference: ref
				}
				logger.info("evaluateResponse:  ", JSON.stringify(response));
				this.sendResponse(response);
			}, error => {
				this.sendErrorResponse(response,21,error);
			})
		}, error => this.sendErrorResponse(response,21,error));
	}

	// 继续执行
	protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
		let threadId = args.threadId;
		this.gdb.continue(threadId).then(()=> {
			this.sendResponse(response);
		},(error) => {
			this.sendErrorResponse(response, 14, error);
		})
	}

	// 下一步执行
	protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
		let threadId = args.threadId;
		this.gdb.next(threadId).then(()=> {
			this.sendResponse(response);
		}, (error) => {
			this.sendErrorResponse(response, 15, error);
		})
	}

	// 跳入执行
	protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {
		let threadId = args.threadId;
		this.gdb.stepIn(threadId).then(()=> {
			this.sendResponse(response);
		}, (error) => {
			this.sendErrorResponse(response, 16, error);
		})
	}

	// 跳出执行
    protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void {
		let threadId = args.threadId;
		this.gdb.stepOut(threadId).then(()=> {
			this.sendResponse(response);
		}, (error) => {
			this.sendErrorResponse(response, 17, error);
		})
	}

	// 暂停执行
	protected pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments): void {
		let threadId = args.threadId;
		this.gdb.interrupt(threadId).then(()=> {
			this.sendResponse(response);
		}, (error) => {
			this.sendErrorResponse(response, 18, error);
		})
	}

	protected dispatchRequest(request: DebugProtocol.Request): void {
		logger.warn('request: ', this.requestNum,request.command);
		this.requestNum++;
		const response = new Response(request);

		try {
			if (request.command === 'initialize') {
				var args = <DebugProtocol.InitializeRequestArguments> request.arguments;

				// if (typeof args.linesStartAt1 === 'boolean') {
				// 	this._clientLinesStartAt1 = args.linesStartAt1;
				// }
				// if (typeof args.columnsStartAt1 === 'boolean') {
				// 	this._clientColumnsStartAt1 = args.columnsStartAt1;
				// }

				if (args.pathFormat !== 'path') {
					this.sendErrorResponse(response, 2018, 'debug adapter only supports native paths', null, ErrorDestination.Telemetry);
				} else {
					const initializeResponse = <DebugProtocol.InitializeResponse> response;
					initializeResponse.body = {};
					this.initializeRequest(initializeResponse, args);
				}

			} else if (request.command === 'launch') {
				this.launchRequest(<DebugProtocol.LaunchResponse> response, request.arguments);

			} else if (request.command === 'attach') {
				this.attachRequest(<DebugProtocol.AttachResponse> response, request.arguments);

			} else if (request.command === 'disconnect') {
				this.disconnectRequest(<DebugProtocol.DisconnectResponse> response, request.arguments);

			} else if (request.command === 'terminate') {
				this.terminateRequest(<DebugProtocol.TerminateResponse> response, request.arguments);

			} else if (request.command === 'restart') {
				this.restartRequest(<DebugProtocol.RestartResponse> response, request.arguments);

			} else if (request.command === 'setBreakpoints') {
				this.setBreakPointsRequest(<DebugProtocol.SetBreakpointsResponse> response, request.arguments);

			} else if (request.command === 'setFunctionBreakpoints') {
				this.setFunctionBreakPointsRequest(<DebugProtocol.SetFunctionBreakpointsResponse> response, request.arguments);

			} else if (request.command === 'setExceptionBreakpoints') {
				this.setExceptionBreakPointsRequest(<DebugProtocol.SetExceptionBreakpointsResponse> response, request.arguments);

			} else if (request.command === 'configurationDone') {
				this.configurationDoneRequest(<DebugProtocol.ConfigurationDoneResponse> response, request.arguments);

			} else if (request.command === 'continue') {
				this.continueRequest(<DebugProtocol.ContinueResponse> response, request.arguments);

			} else if (request.command === 'next') {
				this.nextRequest(<DebugProtocol.NextResponse> response, request.arguments);

			} else if (request.command === 'stepIn') {
				this.stepInRequest(<DebugProtocol.StepInResponse> response, request.arguments);

			} else if (request.command === 'stepOut') {
				this.stepOutRequest(<DebugProtocol.StepOutResponse> response, request.arguments);

			} else if (request.command === 'stepBack') {
				this.stepBackRequest(<DebugProtocol.StepBackResponse> response, request.arguments);

			} else if (request.command === 'reverseContinue') {
				this.reverseContinueRequest(<DebugProtocol.ReverseContinueResponse> response, request.arguments);

			} else if (request.command === 'restartFrame') {
				this.restartFrameRequest(<DebugProtocol.RestartFrameResponse> response, request.arguments);

			} else if (request.command === 'goto') {
				this.gotoRequest(<DebugProtocol.GotoResponse> response, request.arguments);

			} else if (request.command === 'pause') {
				this.pauseRequest(<DebugProtocol.PauseResponse> response, request.arguments);

			} else if (request.command === 'stackTrace') {
				this.stackTraceRequest(<DebugProtocol.StackTraceResponse> response, request.arguments);

			} else if (request.command === 'scopes') {
				this.scopesRequest(<DebugProtocol.ScopesResponse> response, request.arguments);

			} else if (request.command === 'variables') {
				this.variablesRequest(<DebugProtocol.VariablesResponse> response, request.arguments);

			} else if (request.command === 'setVariable') {
				this.setVariableRequest(<DebugProtocol.SetVariableResponse> response, request.arguments);

			} else if (request.command === 'setExpression') {
				this.setExpressionRequest(<DebugProtocol.SetExpressionResponse> response, request.arguments);

			} else if (request.command === 'source') {
				this.sourceRequest(<DebugProtocol.SourceResponse> response, request.arguments);

			} else if (request.command === 'threads') {
				this.threadsRequest(<DebugProtocol.ThreadsResponse> response);

			} else if (request.command === 'terminateThreads') {
				this.terminateThreadsRequest(<DebugProtocol.TerminateThreadsResponse> response, request.arguments);

			} else if (request.command === 'evaluate') {
				this.evaluateRequest(<DebugProtocol.EvaluateResponse> response, request.arguments);

			} else if (request.command === 'stepInTargets') {
				this.stepInTargetsRequest(<DebugProtocol.StepInTargetsResponse> response, request.arguments);

			} else if (request.command === 'gotoTargets') {
				this.gotoTargetsRequest(<DebugProtocol.GotoTargetsResponse> response, request.arguments);

			} else if (request.command === 'completions') {
				this.completionsRequest(<DebugProtocol.CompletionsResponse> response, request.arguments);

			} else if (request.command === 'exceptionInfo') {
				this.exceptionInfoRequest(<DebugProtocol.ExceptionInfoResponse> response, request.arguments);

			} else if (request.command === 'loadedSources') {
				this.loadedSourcesRequest(<DebugProtocol.LoadedSourcesResponse> response, request.arguments);

			} else {
				this.customRequest(request.command, <DebugProtocol.Response> response, request.arguments);
			}
		} catch (e) {
			this.sendErrorResponse(response, 1104, '{_stack}', { _exception: e.message, _stack: e.stack }, ErrorDestination.Telemetry);
		}
	}
}
process.on('uncaughtException', function (err) {
    logger.error('An uncaught error occurred!');
    logger.error(err.stack);
});

GDBSession.run(GDBSession);