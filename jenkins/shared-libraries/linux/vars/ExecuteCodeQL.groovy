def call(org, repo, branch, language, buildCommand, token) {
    sh """
        #!/usr/bin/env bash

        if [ -z "$branch" ]; then
            # This doesn't work if branch includes a slash in it
            branch=\$(echo "${env.GIT_BRANCH}" | cut -d'/' -f2)
        fi

        databasePath="$repo-$language"
        if [[ -z "$buildCommand" ]]; then
            codeql database create "\$databasePath" --language="$language" --source-root .
        else
            codeql database create "\$databasePath" --language="$language" --source-root . --command="$buildCommand"
        fi

        sarifPath="$WORKSPACE_TMP/\$databasePath.sarif"
        codeql database analyze "\$databasePath" "$language-code-scanning.qls" --sarif-category="$language" --format=sarif-latest --output="\$sarifPath"

        commit=\$(git rev-parse HEAD)
        GITHUB_TOKEN="$token" codeql github upload-results \
        --repository="$org/$repo" \
        --ref="refs/heads/$branch" \
        --commit="\$commit" \
        --sarif="\$sarifPath"

        databaseBundle="$language-database.zip"
        codeql database bundle "\$databasePath" --output "\$databaseBundle"
        sizeInBytes=`stat --printf="%s" \$databaseBundle`
        curl --http1.0 --silent --retry 3 -X POST -H "Content-Type: application/zip" \
        -H "Content-Length: \$sizeInBytes" \
        -H "Authorization: token $token" \
        -T "\$databaseBundle" \
        "https://uploads.github.com/repos/$org/$repo/code-scanning/codeql/databases/$language?name=\$databaseBundle"
     """
}
