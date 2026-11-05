/**
 * X-15：聊天里认出「要建一个定时助手」（规则判断，不调模型）。宁可漏认，不可错认。
 */
import { describe, expect, it } from 'vitest';
import { cnNumber, detectAssistantIntent } from '../src/assistants/intent.js';

describe('detectAssistantIntent', () => {
  it('所有者的原话：每周一早上 9 点帮我找新的免费模型，筛好告诉我', () => {
    expect(detectAssistantIntent('每周一早上 9 点帮我找新的免费模型，筛好告诉我')).toEqual({
      name: '找新的免费模型',
      instructions: '找新的免费模型，筛好告诉我',
      schedule: { kind: 'weekly', time: '09:00', days: [1] },
    });
  });

  it.each([
    ['每天早上8点半帮我整理一下今天的新闻要点', { kind: 'daily', time: '08:30' }, '整理一下今天的新闻要点'],
    ['每天 21:00 帮我把今天的待办汇总发给我', { kind: 'daily', time: '21:00' }, '把今天的待办汇总发给我'],
    ['每晚十点提醒我记录今天的心情和吃药情况', { kind: 'daily', time: '22:00' }, '提醒我记录今天的心情和吃'],
    ['每个工作日上午九点帮我看看有没有新的开源项目', { kind: 'weekly', time: '09:00', days: [1, 2, 3, 4, 5] }, '看看有没有新的开源项目'],
    ['每周一、三、五下午3点帮我检查一下服务器状态', { kind: 'weekly', time: '15:00', days: [1, 3, 5] }, '检查一下服务器状态'],
    ['每周日晚上8点给我写一份本周资源周报', { kind: 'weekly', time: '20:00', days: [7] }, '写一份本周资源周报'],
    ['每6小时帮我查一下额度还剩多少，快用完了告诉我', { kind: 'interval', everyHours: 6 }, '查一下额度还剩多少'],
    ['每隔两个小时替我看看新邮件里有没有重要的', { kind: 'interval', everyHours: 2 }, '看看新邮件里有没有重要的'],
  ])('认：%s', (text, schedule, name) => {
    const r = detectAssistantIntent(text);
    expect(r?.schedule).toEqual(schedule);
    expect(r?.name).toBe(Array.from(name).slice(0, 12).join(''));
    expect(Array.from(r!.instructions).length).toBeGreaterThanOrEqual(10);
  });

  it.each([
    ['帮我找新的免费模型，筛好告诉我', '没有计划'],
    ['每周一帮我找新的免费模型', '有日子没有几点'],
    ['我每天早上 9 点起床，然后去散步', '没有请求'],
    ['每周一早上 9 点帮我找新的免费模型可以吗？', '问句'],
    ['怎么让它每天 9 点帮我总结新闻', '问怎么做'],
    ['不要每天 9 点帮我总结新闻了', '否定'],
    ['取消每周一早上 9 点帮我找模型的那个', '取消已有的'],
    ['把每天 9 点帮我总结新闻改成 10 点', '改已有的'],
    ['@张三 每天 9 点帮我总结新闻', '点名成员'],
    ['帮我看看每天 9 点的会议安排有哪些', '计划写在请求后面'],
    ['每天 9 点帮我', '任务太短'],
    ['每月 1 号早上 9 点帮我对一下账单', '不支持每月'],
    ['每 0 小时帮我检查一下服务器状态', '间隔不合法'],
    ['每天 25 点帮我检查一下服务器状态', '时间不合法'],
    ['每天 9 点帮我检查一下服务器状态'.repeat(20), '太长'],
  ])('不认：%s（%s）', (text) => {
    expect(detectAssistantIntent(text)).toBeNull();
  });

  it('中文数字', () => {
    expect([cnNumber('九'), cnNumber('十'), cnNumber('十二'), cnNumber('二十'), cnNumber('二十三'), cnNumber('两'), cnNumber('09'), cnNumber('百')]).toEqual([9, 10, 12, 20, 23, 2, 9, null]);
  });
});
