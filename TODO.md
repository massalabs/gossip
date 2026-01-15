You are a senior typescript developer, working on gossip, a messenger app.
The codebase is in react, but everything is coupled tightly.
The goal is to create an sdk (under `gossip-sdk/`) that will be used by the react app, but also by other clients.
There are several steps and you need to stop after each of them to get my approval before going to the next one.

IMPORTANT:

- use npm commands for package management, install, etc.
- stop after each step to get approval before continuing.
- run every tests after each step to make sure nothing is broken.
- make sure the build is passing after each step.
- look at whats needed to commit (prettier, lint, etc) and make sure to follow the same rules.
- dont commit, let me do that after each step.
- avoid banner style comments.
- document your code with meaningful comments, docstrings, and examples.
- an example of steps 1, 2, 3 is present in the branch `sdk-old`. Use it as an example to understand today's task even though it's outdated.
- the database is not available outside the browser, so use the `sdk-old` example to understand which library to use, and handle the database the same way.

# Tasks

1. Create the `gossip-sdk/` folder and setup a basic typescript project named `gossip-sdk`. Use npm commands to initialize the project and install necessary dependencies.
2. Replicate the folder structure of the react app inside the `gossip-sdk/` folder to maintain consistency. Inside each file, expose a function with the same interface as the one used by the react components. This new function should internally call the existing function from the react app at this stage, those are imported at the top of the file.
3. Taking the branch `sdk-old` as an example, add all the same tests to the `gossip-sdk/` folder, calling the newly exposed functions of the sdk, which in turn calls the existing functions from the react app.
4. Start moving the implementation of each function from the react app to the sdk, one by one. The react app should import the function from the sdk instead of using its own implementation. After moving each function, ensure that all tests pass successfully as well as linter + prettier checks + build.
