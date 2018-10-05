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
    
class GDBSession extends DebugSession {

	private gdb: GDB;

	constructor() {
		super();
	}
	private registerListener() {
		if (this.gdb) {
			this.gdb.addListener('stop', (event) => {
				let stopEvent = new StoppedEvent(event['reason'], event['thread-id']);
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
		// breakpointPath = breakpointPath.replace(/\\/g, '\\\\');
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
	}

	protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
		logger.info('配置完成请求完成')
		this.sendResponse(response);
		this.emit('start');
	}
}
GDBSession.run(GDBSession);