import { fireEvent, render, screen } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import { Markdown } from '../src/components/Markdown';

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(() => Promise.resolve(true)) }));
jest.mock('expo-haptics', () => ({
  notificationAsync: jest.fn(),
  NotificationFeedbackType: { Success: 'success' },
}));

const reply = `Here’s the plan:

1. **Read** the project
2. Make the change
   - on a branch

| Check | Status |
| --- | --- |
| Links | 0 broken |

\`\`\`bash
pnpm build
\`\`\``;

describe('Markdown', () => {
  it('renders lists, tables and code, and copies the code', async () => {
    await render(<Markdown text={reply} />);
    expect(screen.getByText('1.')).toBeTruthy();
    expect(screen.getByText('Read')).toBeTruthy();
    expect(screen.getByText('◦')).toBeTruthy(); // nested bullet
    expect(screen.getByText('0 broken')).toBeTruthy();
    expect(screen.getByText('pnpm build')).toBeTruthy();

    await fireEvent.press(screen.getByLabelText('Copy code'));
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith('pnpm build');
    expect(await screen.findByText('Copied')).toBeTruthy();
  });

  it('shows entities as characters', async () => {
    await render(<Markdown text={'Use `a < b && c > d`'} />);
    expect(screen.getByText('a < b && c > d')).toBeTruthy();
  });
});
