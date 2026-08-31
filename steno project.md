PRD
We work with thousands of lawyers who litigate. As part of the litigation process, one of the first steps they do is create something called a “demand letter”. Today they spend a lot of time reviewing source documents in order to create this output. We want to use AI to generate a draft version of this demand letter on their behalf, which will ultimately make our clients more efficient in their litigation process. We will provide the source documents and information needed for an LLM to generate this, as well as a “template” for what the output should look like. Demand letter definition: https://www.law.cornell.edu/wex/demand_letter

Business Context
This will be a new tool that we offer to clients to allow them to upload the relevant source material, as well as allowing them to create “templates” at a firm level for how their demand letters should be structured. This should increase the number of deals closed with law firms, and for firms that adopt this technology this should increase net revenue retention.

Functional Requirements
Given a real demand letter as a template and relevant legal case materials, implement a system that generates a demand letter that matches the template exactly in structure, formatting, and layout, populated with information relevant to the case. Accuracy is paramount. The attorney should also be able to give further instructions on the draft document to further refine the output using AI. If you use codegen it must be sandboxed and secure. Generated code should never execute with access to sensitive data or system resources. Cost and time to process are not a concern. As a stretch goal, allow online collaboration and editing of the generated output in a webview with all changes tracked to see who made what change, similar to Google Docs. The resulting document should be exportable to Word format. Bonus points for good developer experience. Consider how this project would be handed off to other engineers and structure your code, documentation, and architecture decisions accordingly. Note: We can provide sample data, a completed demand letter with its corresponding inputs, and access to an attorney for domain-specific guidance, if needed.

Performance Benchmarks
HTTP Request/Response time should be no longer than 5 seconds (non streaming). Database queries should generally be no longer than 2 seconds. AI model calls should prefer streaming protocols (SSE) and agent and/or batch based workflows should be asynchronous (queued).

Code Quality Expectations
Code quality should follow established language conventions and industry best practices. While the code does not need to be production-ready, it should emphasize readability, maintainability, and clear structure. Engineers should avoid unnecessary duplication (“copy-pasta”), write self-explanatory code, and design with extensibility and future scalability in mind. Every engineer must be able to explain and defend the reasoning behind their code; any generated or written code that cannot be clearly explained is not acceptable.

Required Languages
Typescript, Python (if needed), SQL

AI / ML Frameworks
None, but we prefer Anthropic Claude models (Anthropic API or AWS Bedrock)

Dev Tools
React, NodeJS, Python, Containerization, Lambda (AWS SAM)

Cloud Platforms
AWS

Other Requirements
PostgreSQL-based persistence (preferred)

Off-Limits Tech
DeepSeek, avoid platform-as-a-developer-experience tools (eg: Vercel, Heroku), legacy tech (Tomcat, IIS, etc)

Required Deliverables
- Source Code
- AI Usage Log
- Test Results