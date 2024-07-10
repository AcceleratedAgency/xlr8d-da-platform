let crewai_task = {
    type: 'crewai-reviews-task',
    id: "firestore_queue_document_id",
    client: "Client Name",
    client_id: "firestore_client_collection_id",
    report: "report-name",
    start_date: "timestamp",
    end_date: "timestamp",
    prompt: "additional prompt"
}
let crewai_chat = {
    id: "firestore_queue_document_id",
    require_user_response: false,
    content: ""
}
let cancel_task = {id: "firestore_queue_document_id"}
let firestore_queue_task_document = {
    type: 'crewai-reviews-task',
    status: "new",
    require_user_response: false,
    user_response: null,
    chat: [],
    client: "Client Name",
    report: "report-name",
    start_date: "timestamp",
    end_date: "timestamp",
    prompt: "additional prompt"
}