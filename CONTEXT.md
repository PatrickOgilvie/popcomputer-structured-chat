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

**Detection**:
An assessment of whether user input supplies an answer to a question. Detection may be uncertain and does not establish an accepted value.
_Avoid_: accepted answer, extracted value

**Extraction**:
Interpretation of user evidence into a proposed answer value. A proposal can still fail the question's grounding or acceptance rules.
_Avoid_: confirmation, workflow commitment

**Accepted answer**:
A retained answer value supported by eligible evidence and satisfying its acceptance rules. New grounded input may correct it.
_Avoid_: detected answer, unvalidated proposal

**Interview**:
A stage that collects required and optional answers by choosing the next question
or registered query tool in response to the conversation. Tool use retains the
interview’s progress and does not complete the stage. Required answers govern readiness to finish;
question order is a separate decision.
_Avoid_: fixed questionnaire, unrestricted chat

**Question selection**:
A proposal to ask one eligible question, use a registered query tool, or finish an interview. It uses the
retained conversation and accepted answers but cannot accept values or bypass
completion requirements.
_Avoid_: answer detection, extraction, accepted answer

**Answer objective**:
The information an interview seeks to establish, independently of the wording
used to ask for it. A required objective can be satisfied by eligible evidence
without directly asking its default question.
_Avoid_: mandatory wording, fixed questionnaire item

**Probe**:
A question that gathers evidence for an answer objective through the participant's
examples, circumstances, or desired changes. A probe does not introduce a separate
answer objective merely because its wording is different.
_Avoid_: flavour field, additional required answer

**Question focus**:
The interview question issued to the user and awaiting a reply. Focus is persisted
independently of declaration order; a reply may also answer or correct other fields.
_Avoid_: first missing field, confirmed answer

**Declined answer**:
An optional field the user explicitly chose not to supply, with retained user
evidence. Absence alone is not a decline; newer evidence may supply the answer.
_Avoid_: default value, accepted answer
