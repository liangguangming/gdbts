import logger from '../log';
import { create } from '../gdb';

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
    gdb.fetchVariable().then((variables) => {
        variables.forEach(variable => {
            logger.warn('fet__variable: ', variable);
            if (variable.numchild && Number(variable.numchild) > 0) {
                gdb.getChildVariables(variable.name).then((vars) => {
                    logger.warn('fet___childVariables: ', JSON.stringify(vars));
                });
            }
        })
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
        condition: null,
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