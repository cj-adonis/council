import { expect, test } from 'vitest';
import { extractOptions } from './options';

test('natural confirmation questions provide yes/no without requiring special formatting', () => {
  expect(extractOptions('Would you like me to add tests?')).toEqual(['Yes', 'No']);
  expect(extractOptions('Should I continue?')).toEqual(['Yes', 'No']);
  expect(extractOptions('Do you want me to proceed?')).toEqual(['Yes', 'No']);
  expect(extractOptions('Should I use Redis or Postgres?')).toEqual([]);
});

test('example questions and options inside code fences are not actionable choices', () => {
  expect(extractOptions('Example:\n```text\nWould you like me to proceed?\nChoose:\n1. Red\n2. Blue\n```')).toEqual([]);
});

test('extracts numbered options from assistant text', () => {
  const text = `I encountered an error running prisma migrate. Which option do you prefer?
1. Reset the database schema
2. Apply migration manually
3. Abort the task`;
  expect(extractOptions(text)).toEqual([
    'Reset the database schema',
    'Apply migration manually',
    'Abort the task',
  ]);
});

test('extracts bullet options when preceded by a choice prompt', () => {
  const text = `Choose one of the following approaches:
- Use OAuth 2.0 authentication
- Use API Key authentication`;
  expect(extractOptions(text)).toEqual([
    'Use OAuth 2.0 authentication',
    'Use API Key authentication',
  ]);
});

test('extracts yes / no when assistant asks a direct yes/no question', () => {
  const text = 'Should I proceed with deleting the temporary files? (y/n)';
  expect(extractOptions(text)).toEqual(['Yes', 'No']);
});

test('extracts options from ask_user tool parameters', () => {
  const toolInput = {
    questions: [
      {
        question: 'Which authentication provider should we configure?',
        header: 'Auth',
        type: 'choice',
        options: [
          { label: 'Google OAuth', description: 'Supports SSO' },
          { label: 'GitHub OAuth', description: 'Developer friendly' },
        ],
      },
    ],
  };
  expect(extractOptions(undefined, toolInput)).toEqual([
    'Google OAuth',
    'GitHub OAuth',
  ]);
});

test('returns empty array when text has no choice prompt', () => {
  const text = 'I have edited src/index.ts and added the new function.';
  expect(extractOptions(text)).toEqual([]);
  expect(extractOptions(undefined)).toEqual([]);

  const bulletNoPrompt = `Summary of edits:
- Modified index.ts
- Updated package.json`;
  expect(extractOptions(bulletNoPrompt)).toEqual([]);
});

test('extracts options from ask_user with yesno type and string options', () => {
  const yesnoTool = {
    questions: [
      {
        question: 'Deploy to production?',
        type: 'yesno',
      },
    ],
  };
  expect(extractOptions(undefined, yesnoTool)).toEqual(['Yes', 'No']);

  const stringOptionsTool = {
    questions: [
      {
        question: 'Choose an environment',
        type: 'choice',
        options: ['Staging', 'Production'],
      },
    ],
  };
  expect(extractOptions(undefined, stringOptionsTool)).toEqual(['Staging', 'Production']);
});
