# Structured conversations

Structured conversations connect natural-language exchanges to application-owned questions, evidence, and operations.

## Language

**Observation**:
Speech received from a conversation participant, retaining its original speaker and source identity. An observation is not an explicit application submission or proof that speech was heard.
_Avoid_: confirmed answer, issued question

**Submission**:
User text explicitly submitted through the application. Unlike an observation, a submission can confirm an answer after its question has been issued.
_Avoid_: transcript fragment, inferred confirmation

**Authored message**:
Assistant text produced by the application's workflow. Authorship permits a message to be issued as a question or reply offer, but does not itself establish issuance.
_Avoid_: observed assistant speech, issued question

**Delegation**:
A voice conversation's request for application work. A delegation identifies a request but does not itself establish a complete user intent.
_Avoid_: tool call, completed turn

**Candidate**:
A revisable selection of observed speech that an application may accept as the context for one workflow turn.
_Avoid_: completed utterance

**Command admission**:
The point at which an application command has been authorized to begin. Later corrections may supersede its conversational intent but do not undo its effects.
_Avoid_: command completion

**Presentation**:
An explicit projection of a workflow outcome for speech and application display. It is distinct from the private application result.
_Avoid_: transcript, server result

**Workflow commitment**:
A completed advancement of the application workflow. Preparing a clarification or other presentation does not by itself advance the workflow.
_Avoid_: output prepared, command admitted

**Accepted delivery**:
An acknowledged context update to the voice conversation. Acceptance does not establish that the assistant spoke it or that a person heard it.
_Avoid_: spoken, heard

**Provider finalization**:
The voice provider's acknowledgement that a session has ended, including its final usage. This remains true even if application work or delivery subsequently fails.
_Avoid_: transport disconnected, application completed
