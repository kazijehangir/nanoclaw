import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GroupQueue } from './group-queue.js';
import * as crypto from 'node:crypto';
import fs from 'node:fs';
import { processTaskIpc } from './ipc.js';
import * as db from './db.js';

vi.mock('node:crypto', () => ({
  randomUUID: vi.fn().mockReturnValue('mocked-uuid-1234'),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      renameSync: vi.fn(),
      promises: {
        mkdir: vi.fn(),
        writeFile: vi.fn(),
        rename: vi.fn(),
      },
    },
  };
});

vi.mock('./db.js', () => ({
  createTask: vi.fn(),
  getTaskById: vi.fn(),
  updateTask: vi.fn(),
  deleteTask: vi.fn(),
}));

describe('Security Fix: Secure Randomness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GroupQueue.sendMessage should use secure randomness for filenames', async () => {
    const queue = new GroupQueue();
    const groupJid = 'test@g.us';

    // Register process to set groupFolder
    const proc: any = { killed: false };
    queue.registerProcess(groupJid, proc, 'container-1', 'group-folder-1');

    let sendMessageResult = false;
    queue.setProcessMessagesFn(async () => {
      sendMessageResult = await queue.sendMessage(groupJid, 'hello');
      return true;
    });

    queue.enqueueMessageCheck(groupJid);

    // Give it a moment to run
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(sendMessageResult).toBe(true);
    expect(crypto.randomUUID).toHaveBeenCalled();

    // Check if the filename contains the UUID
    const writeFileMock = vi.mocked(fs.promises.writeFile);
    const lastCall = writeFileMock.mock.calls[0];
    const filePath = lastCall[0] as string;
    expect(filePath).toContain('mocked-uuid-1234');
  });

  it('processTaskIpc should use secure randomness for task IDs', async () => {
    const deps: any = {
      registeredGroups: () => ({
        'target@g.us': { folder: 'target-folder' },
      }),
    };

    const taskData = {
      type: 'schedule_task',
      prompt: 'test prompt',
      schedule_type: 'once',
      schedule_value: new Date().toISOString(),
      targetJid: 'target@g.us',
    };

    await processTaskIpc(taskData, 'source-group', true, deps);

    expect(crypto.randomUUID).toHaveBeenCalled();
    const createTaskMock = vi.mocked(db.createTask);
    const taskArg = createTaskMock.mock.calls[0][0];
    expect(taskArg.id).toContain('mocked-uuid-1234');
  });
});
