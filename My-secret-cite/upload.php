<?php
session_start();
if (!isset($_SESSION['loggedin']) || $_SESSION['loggedin'] !== true) {
    die('Рұқсат жоқ. <a href="index.php">Кіру</a>');
}

if ($_FILES['myfile']['error'] === UPLOAD_ERR_OK) {
    $filename = time() . '_' . basename($_FILES['myfile']['name']);
    move_uploaded_file($_FILES['myfile']['tmp_name'], 'uploads/' . $filename);
    header('Location: index.php');
} else {
    echo 'Қате! <a href="index.php">Артқа</a>';
}
?>