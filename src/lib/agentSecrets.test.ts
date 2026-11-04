import { describe, expect, it } from 'vitest';
import { findSecret, secretVars } from './agentSecrets';

describe('findSecret', () => {
  it('spots common key shapes and names them', () => {
    const cases: [string, string, string][] = [
      ['use sk_live_51HxAbCdEfGhIjKlMnOp for it', 'sk_live_51HxAbCdEfGhIjKlMnOp', 'stripe_key'],
      [
        'ghp_0123456789abcdefghijABCDEFGHIJ012345',
        'ghp_0123456789abcdefghijABCDEFGHIJ012345',
        'github_token',
      ],
      [
        'key sk-ant-api03-abcdefghijklmnopqrstuv',
        'sk-ant-api03-abcdefghijklmnopqrstuv',
        'anthropic_key',
      ],
      ['sk-proj-abcdefghijklmnopqrstuvwx', 'sk-proj-abcdefghijklmnopqrstuvwx', 'openai_key'],
      ['AKIAIOSFODNN7EXAMPLE', 'AKIAIOSFODNN7EXAMPLE', 'aws_access_key_id'],
      ['password: hunter2hunter2', 'hunter2hunter2', 'credential'],
    ];
    for (const [text, value, name] of cases) {
      expect(findSecret(text)).toMatchObject({ value, name });
    }
  });

  it('leaves ordinary messages alone', () => {
    for (const text of [
      'Can you check the Stripe payouts?',
      'the token count went up',
      'set the password field to required',
      'sk_live is the prefix',
    ]) {
      expect(findSecret(text)).toBeNull();
    }
  });
});

describe('secretVars', () => {
  it('lists every variable', () => {
    expect(
      secretVars({
        fields: [
          { label: 'Username', env: 'BANK_USERNAME' },
          { label: 'Password', env: 'BANK_PASSWORD' },
        ],
      })
    ).toBe('$BANK_USERNAME, $BANK_PASSWORD');
  });
});
