import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { useAsk } from '@/components/Dialog';

function Demo() {
  const ask = useAsk();
  const [out, setOut] = useState('');
  return (
    <div>
      <button type="button" onClick={async () => setOut(String(await ask.confirm({ title: '删除会话「甲」？', desc: '删了找不回来。', ok: '删除', danger: true })))}>
        删
      </button>
      <button type="button" onClick={async () => setOut(String(await ask.prompt({ title: '重命名话题', label: '新名字', value: '旧名' })))}>
        改
      </button>
      <p data-testid="out">{out}</p>
      {ask.node}
    </div>
  );
}

afterEach(cleanup);

describe('统一弹窗（代替 window.confirm / prompt）', () => {
  it('确认：有标题和说明，默认焦点在「取消」，取消得到 false、删除得到 true', async () => {
    render(<Demo />);
    fireEvent.click(screen.getByRole('button', { name: '删' }));
    const dlg = await screen.findByRole('dialog', { name: '删除会话「甲」？' });
    expect(dlg).toHaveAccessibleDescription('删了找不回来。');
    expect(screen.getByRole('button', { name: '取消' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.getByTestId('out').textContent).toBe('false'));
    fireEvent.click(screen.getByRole('button', { name: '删' }));
    fireEvent.click(await screen.findByRole('button', { name: '删除' }));
    await waitFor(() => expect(screen.getByTestId('out').textContent).toBe('true'));
  });
  it('输入：标签在上、预填旧名，焦点在输入框；改完保存得到新名字，Esc（cancel）得到 null', async () => {
    render(<Demo />);
    fireEvent.click(screen.getByRole('button', { name: '改' }));
    const box = await screen.findByLabelText('新名字');
    expect(box).toHaveValue('旧名');
    expect(box).toHaveFocus();
    fireEvent.change(box, { target: { value: '新名' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(screen.getByTestId('out').textContent).toBe('新名'));
    fireEvent.click(screen.getByRole('button', { name: '改' }));
    fireEvent(await screen.findByRole('dialog'), new Event('cancel', { cancelable: true }));
    await waitFor(() => expect(screen.getByTestId('out').textContent).toBe('null'));
  });
});
