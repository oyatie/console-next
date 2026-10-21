export const expectedProtectedWorkflow = Object.freeze({
  name: 'Console authority bootstrap',
  on: {
    pull_request_target: {
      types: ['opened', 'synchronize', 'reopened', 'edited', 'ready_for_review'],
      branches: ['main'],
    },
  },
  permissions: { actions: 'read', contents: 'read', 'pull-requests': 'read' },
  jobs: {
    'authenticate-console-authority': {
      'runs-on': 'ubuntu-latest',
      'timeout-minutes': 12,
      steps: [
        {
          name: 'Checkout protected target code only',
          uses: 'actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0',
          with: {
            ref: '${{ github.event.pull_request.base.sha }}',
            'persist-credentials': false,
            'fetch-depth': 0,
          },
        },
        {
          name: 'Verify exact PR coordinates from protected code',
          env: {
            HOME: '${{ runner.temp }}/hostile-home',
            GITHUB_TOKEN: '${{ secrets.GITHUB_TOKEN }}',
            PR_NUMBER: '${{ github.event.pull_request.number }}',
            PR_HEAD_SHA: '${{ github.event.pull_request.head.sha }}',
            PR_BASE_SHA: '${{ github.event.pull_request.base.sha }}',
            PR_BASE_REF: '${{ github.event.pull_request.base.ref }}',
            REPOSITORY: '${{ github.repository }}',
          },
          run: [
            'node scripts/console/verify-console-pr-authority-bootstrap.mjs \\',
            '--pr-number "$PR_NUMBER" \\',
            '--head "$PR_HEAD_SHA" \\',
            '--base-sha "$PR_BASE_SHA" \\',
            '--base "$PR_BASE_REF" \\',
            '--repository "$REPOSITORY"',
            '',
          ].join('\n'),
        },
      ],
    },
  },
});
