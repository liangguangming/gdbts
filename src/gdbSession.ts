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
import { create, GDB } from './gdb'
import * as gdbModel from './gdbModel'

const LOCALREFERENCE = 512*512;

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
 */
    
class GDBSession extends DebugSession {

	private gdb: GDB;
	private requestNum = 1;
	private variableMap: Map<number,string> = new Map();
	private rootVariablesName: string[] = [];

	constructor() {
		super();
	}

	private registerListener() {
		if (this.gdb) {
			this.gdb.addListener('stop', (event) => {
				let stopEvent = new StoppedEvent(event['reason'], Number(event['thread-id']));
				logger.info('触发断点停止，thread: ', stopEvent);
				this.sendEvent(stopEvent);
			});
			this.gdb.addListener('exit', (event) => {
				let exitEvent = new TerminatedEvent(false);
				this.sendEvent(exitEvent);
			});
		}
	}

	private removeAllListener() {
		this.gdb.removeAllListeners();
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
		this.gdb.setApplicationPath(target).then(() => {
			this.sendEvent(new InitializedEvent());
		});
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
				condition: bp.condition,
				ignore: bp.hitCondition? Number(bp.hitCondition): null,
				enabled: true,
				address: null
			}
			breakPointDatas.push(breakpoint);
		})
		// 清理以前的断点
		this.gdb.clearBreakpointByfilePath(breakpointPath).then(()=> {

			// 新增断点
			let all: Promise<[boolean , string|gdbModel.Breakpoint]>[] = [];
			breakPointDatas.forEach(bp => {
				all.push(this.gdb.addBreakpoint(bp));
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
		this.gdb.getAllStackFrame().then((frames) => {
			let stackFrames: DebugProtocol.StackFrame[] = [];
			let id = 1;
			frames.forEach(frame => {
				let source: DebugProtocol.Source = {
					name: frame.file,
					path: frame.fullname
				}
				source.path = source.path.replace(/\\\\/g, '\\');
				logger.info('source.path: ', source.path);
				let stackFrame: DebugProtocol.StackFrame = {
					line: Number(frame.line),
					name: frame.func,
					id: id,
					column: 0,
					source: source
				}
				stackFrames.push(stackFrame);
				id++;
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
			
			// response.body.threads = threads;
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
		// 先清理数据再响应
		let all: Promise<any>[] = [];
		this.rootVariablesName.forEach((name) => {
			all.push(this.gdb.deleteVariable(name));
		})
		Promise.all(all).then(()=> {
			let scope: DebugProtocol.Scope = {
				name: 'Locals',
				variablesReference: LOCALREFERENCE,
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
		let variablesReference = args.variablesReference;
		let variables: Variable[] = [];
		if (variablesReference === LOCALREFERENCE) {
			let count = 1;
			this.gdb.fetchVariable().then((vars) => {
				vars.forEach(v => {
					let variable: Variable = null;
					this.rootVariablesName.push(v.name);
					if (Number(v.numchild)>0) {
						let ref = Number(LOCALREFERENCE + `${count++}`);
						variable = new Variable(v.name,v.value,	ref);
						this.variableMap.set(ref, v.name);
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
		} else if(variablesReference > LOCALREFERENCE) {
			let name = this.getVariableName(variablesReference);
			let count = 1;
			this.gdb.getChildVariables(name).then((vars)=>{
				try {
					vars.forEach(v => {
						let variable: Variable = null;
						if (Number(v.numchild)>0) {
							let ref = Number(LOCALREFERENCE + `${count++}`);
							variable = new Variable(v.name,v.value,	ref);
							this.variableMap.set(ref, v.parentName);
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

	// 继续执行
	protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
		this.gdb.continue().then(()=> {
			this.sendResponse(response);
		},(error) => {
			this.sendErrorResponse(response, 14, error);
		})
	}

	// 下一步执行
	protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
		this.gdb.next().then(()=> {
			this.sendResponse(response);
		}, (error) => {
			this.sendErrorResponse(response, 15, error);
		})
	}

	// 跳入执行
	protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {
		this.gdb.stepIn().then(()=> {
			this.sendResponse(response);
		}, (error) => {
			this.sendErrorResponse(response, 16, error);
		})
	}

	// 跳出执行
    protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void {
		this.gdb.stepOut().then(()=> {
			this.sendResponse(response);
		}, (error) => {
			this.sendErrorResponse(response, 17, error);
		})
	}

	// 暂停执行
	protected pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments): void {
		this.gdb.interrupt().then(()=> {
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
GDBSession.run(GDBSession);