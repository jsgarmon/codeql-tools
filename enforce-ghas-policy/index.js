const core = require('@actions/core')
const {Octokit} = require('@octokit/rest')
const {retry} = require('@octokit/plugin-retry')
const {throttling} = require('@octokit/plugin-throttling')

const org = core.getInput('ORG', {required: true, trimWhitespace: true})
const repo = core.getInput('REPO', {required: true, trimWhitespace: true})
const ref = core.getInput('REF', {required: true, trimWhitespace: true})
const pullRequestNumber = core.getInput('PULL_REQUEST_NUMBER', {required: true, trimWhitespace: true})
const threshold = core.getInput('THRESHOLD', {required: true, trimWhitespace: true}).toLowerCase()
const token = core.getInput('TOKEN', {required: true, trimWhitespace: true})

const thresholds = [
    {name: 'error'},
    {name: 'note'},
    {name: 'warning'},
    {name: 'low'},
    {name: 'medium'},
    {name: 'high'},
    {name: 'critical'}
]

const _Octokit = Octokit.plugin(retry, throttling)
const client = new _Octokit({
    auth: token,
    throttle: {
        onRateLimit: (retryAfter, options, octokit) => {
            octokit.log.warn(`Request quota exhausted for request ${options.method} ${options.url}`);
            if (options.request.retryCount === 0) {
                octokit.log.info(`Retrying after ${retryAfter} seconds!`);
                return true;
            }
        },
        onSecondaryRateLimit: (retryAfter, options, octokit) => {
            octokit.log.warn(`Abuse detected for request ${options.method} ${options.url}`);
        },
    }

})

const calculateThresholds = (threshold) => {
    let found = false
    const validThresholds = []
    for (const i in thresholds) {
        if (found || thresholds[i].name === threshold) {
            found = true
        } else {
            continue
        }
        validThresholds.push(thresholds[i])
    }

    return validThresholds
}

const comment = async (org, repo, number, message) => {
    try {
        await client.issues.createComment({
            owner: org,
            repo: repo,
            issue_number: number,
            body: message
        })
    } catch (e) {
        throw new Error(`Error commenting on PR #${number}: ${e.message}`)
    }
}

const parseTotalPages = (link) => {
    const regex = /page=(\d+)>; rel="last"/
    const match = regex.exec(link)
    if (match) {
        return parseInt(match[1], 10)
    }
    return 0
}

const main = async () => {
    try {
        if (!thresholds.some(t => t.name === threshold)) {
            return core.setFailed(`Invalid threshold [${threshold}], must be one of: ${thresholds.map(t => t.name).join(', ')}`)
        }

        const findings = {}
        let violation = false
        core.info(`Calculating threshold using baseline: ${threshold}`)
        const validThresholds = calculateThresholds(threshold)
        core.info(`Validating the following thresholds: ${validThresholds.map(t => t.name).join(', ')}`)
        for (const threshold of validThresholds) {
            const severity = threshold.name
            core.info(`Retrieving ${severity} severity CodeQL Code Scanning alerts for ${org}/${repo}/${ref}`)
            const response = await client.codeScanning.listAlertsForRepo({
                owner: org,
                repo: repo,
                ref: ref,
                severity: severity,
                state: 'open',
                tool_name: 'CodeQL',
                per_page: 1
            })
            const totalPages = parseTotalPages(response.headers.link)
            if (totalPages === 0 && response.data.length === 1 || totalPages > 0) {
                if (!violation) violation = true
                findings[severity] = totalPages === 0 ? 1 : totalPages
                core.setFailed(`Found CodeQL Code Scanning alert of severity for ref ${ref} that exceed the ${severity} threshold`)
            } else {
                core.info(`No CodeQL Code Scanning alerts of severity ${severity} for ref ${ref}`)
            }
        }

        if (violation) {
            core.info(`Creating pull request comment for pull request #${pullRequestNumber}`)
            const message = `### CodeQL Code Scanning Alerts\n\nYour pull request violates the configured code scanning severity threshold(s) for the following severity(s):\n\n| Severity | Count |\n| --- | --- |\n${Object.keys(findings).map(key => `| [${key}](https://github.com/${org}/${repo}/security/code-scanning?query=is%3Aopen+pr%3A${pullRequestNumber}+severity%3A${key}) | ${findings[key]} |`).join('\n')}\n\nPlease fix the issues and re-run the workflow.`
            return await comment(org, repo, pullRequestNumber, message)
        }
        core.info('No violations found')
    } catch (e) {
        return core.setFailed(`Error validating CodeQL usage: ${e.message}`)
    }
}

main()